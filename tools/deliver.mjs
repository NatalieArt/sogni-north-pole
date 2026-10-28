#!/usr/bin/env node
// Delivery: turn the approved originals into the files the world serves, and check every served file.
//
//   node tools/deliver.mjs            encode what is missing, write np-world.json, check everything
//   node tools/deliver.mjs --check    only check np-world.json and the files it serves (exit 1 on any issue)
//   node tools/deliver.mjs --jobs 3   films encoded at once (default 3)
//
// np-world.source.json names the approved originals (PNG stills, H3 films) and is never served from.
// np-world.json is written from it, pointing at served/:
//
//   stills   served/stills/<name>.webp: WebP quality 84, same pixel size, no metadata
//   films    served/films/full/<name>.mp4 at the original size and served/films/720/<name>.mp4 at 1280x720,
//            both through Sogni's streaming profile as the Worlds Kit encodes it (cli/lib/delivery.js at
//            3d6ca81): H.264 high, preset slow, CRF 23, bitrate capped by the short edge, a keyframe every 2 s,
//            yuv420p, fast start, and a last frame as sharp as the rest (held tail + forced IDR, cut back and
//            proven frame-exact). The sound is copied from the original untouched.
//
// The originals stay where they are; nothing is deleted. og.jpg and preview.mp4 keep their URLs.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'np-world.source.json');
const SERVED = join(ROOT, 'np-world.json');
const CRF = 23, GOP_SECONDS = 2, TAIL_SECONDS = 1, TOLERANCE = 0.05;
const TIERS = { full: null, 720: { width: 1280, height: 720 } };

const bitrateProfile = (width, height) => Math.min(width, height) <= 768
  ? { name: '768p', maxrate: 4_500_000, bufsize: 9_000_000 }
  : Math.min(width, height) <= 1080
    ? { name: '1080p', maxrate: 8_000_000, bufsize: 16_000_000 }
    : { name: '2K', maxrate: 12_000_000, bufsize: 24_000_000 };

const videoArgs = ({ width, height, fps }) => {
  const { maxrate, bufsize } = bitrateProfile(width, height);
  return ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', String(CRF), '-maxrate', String(maxrate), '-bufsize', String(bufsize),
    '-g', String(Math.max(1, Math.round(fps * GOP_SECONDS))), '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
};

function run(cmd, args) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => err.push(d));
    p.on('error', fail);
    p.on('close', (code) => code === 0 ? ok(Buffer.concat(out).toString('utf8'))
      : fail(new Error(`${cmd} ${args.join(' ')}\n${Buffer.concat(err).toString('utf8').slice(-2000)}`)));
  });
}
const ffmpeg = (args) => run('ffmpeg', ['-v', 'error', '-y', ...args]);
const ffprobe = (args) => run('ffprobe', ['-v', 'error', ...args]);

async function probe(path) {
  const j = JSON.parse(await ffprobe(['-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames:format=duration', '-of', 'json', path]));
  const s = j.streams[0], [n, d] = s.r_frame_rate.split('/').map(Number);
  return { width: s.width, height: s.height, fps: d ? n / d : 24, frames: Number(s.nb_read_frames), seconds: Number(j.format.duration) };
}
const frameHashes = async (path) => (await ffmpeg(['-i', path, '-map', '0:v:0', '-f', 'framemd5', '-']))
  .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').at(-1).trim());
const videoPackets = async (path) => (await ffprobe(['-select_streams', 'v:0', '-show_entries', 'packet=size,flags', '-of', 'csv=p=0', path]))
  .split('\n').filter(Boolean).map((l) => { const [size, flags = ''] = l.split(','); return { bits: Number(size) * 8, key: flags.includes('K') }; });

function vbvLowest(frameBits, { maxrate, bufsize }, fps) {
  let level = bufsize * 0.9, lowest = Infinity;
  for (const bits of frameBits) { level -= bits; lowest = Math.min(lowest, level); level = Math.min(bufsize, level + maxrate / fps); }
  return lowest;
}

/** The Kit's encodeFilm: a held tail so the last frame is not starved, cut back by stream copy and proven exact. */
async function encodeFilm(master, out, { width, height }) {
  const info = await probe(master);
  const fps = info.fps || 24, frames = info.frames;
  const scale = width === info.width && height === info.height ? [] : [`scale=${width}:${height}:flags=lanczos`];
  const temp = join(dirname(out), `.encode-${basename(out, '.mp4')}`);
  const padded = `${temp}.padded.mp4`, picture = `${temp}.picture.mp4`, partial = `${temp}.partial.mp4`;
  try {
    await ffmpeg(['-i', master, '-map', '0:v:0', '-vf', [...scale, `tpad=stop_mode=clone:stop_duration=${TAIL_SECONDS}`].join(','),
      '-force_key_frames', `expr:eq(n,${frames - 1})`, ...videoArgs({ width, height, fps }), '-forced-idr', '1', '-fps_mode', 'passthrough', '-an', padded]);
    await ffmpeg(['-i', padded, '-map', '0:v:0', '-c', 'copy', '-frames:v', String(frames), picture]);
    const kept = await frameHashes(picture), all = await frameHashes(padded);
    if (kept.length !== frames) throw new Error(`${out}: kept ${kept.length} frames, not ${frames}`);
    const differs = kept.findIndex((h, i) => h !== all[i]);
    if (differs >= 0) throw new Error(`${out}: kept frame ${differs} differs from the padded encode`);
    if (!(await videoPackets(picture)).at(-1)?.key) throw new Error(`${out}: the last frame is not a keyframe`);
    await ffmpeg(['-i', picture, '-i', master, '-map', '0:v:0', '-map', '1:a?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', partial]);
    const done = await probe(partial);
    if (done.frames !== frames) throw new Error(`${out}: ${done.frames} frames, the master has ${frames}`);
    if (Math.abs(done.seconds - info.seconds) >= 1 / fps) throw new Error(`${out}: lasts ${done.seconds} s, the master ${info.seconds} s`);
    const lowest = vbvLowest((await videoPackets(partial)).map((p) => p.bits), bitrateProfile(width, height), fps);
    if (lowest < 0) throw new Error(`${out}: overruns its cap's buffer by ${Math.round(-lowest)} bits`);
    renameSync(partial, out);
  } finally { for (const f of [padded, picture, partial]) rmSync(f, { force: true }); }
}

const writeStill = (source, target) => ffmpeg(['-i', source, '-map_metadata', '-1', '-pix_fmt', 'bgra', '-c:v', 'libwebp', '-quality', '84', '-compression_level', '6', '-f', 'webp', target]);

async function fastStart(path) {
  const h = await open(path);
  try {
    const head = Buffer.alloc(16);
    for (let offset = 0, n = 0; n < 100; n++) {
      const { bytesRead } = await h.read(head, 0, 16, offset);
      if (bytesRead < 8) return false;
      let size = head.readUInt32BE(0);
      const type = head.toString('ascii', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (size === 1) size = Number(head.readBigUInt64BE(8));
      if (size < 8) return false;
      offset += size;
    }
    return false;
  } finally { await h.close(); }
}

/** The Kit's measureFilm + filmIssues: codec, pixel format, fast start, keyframe spacing and the cap's buffer. */
async function filmIssues(path, where) {
  const j = JSON.parse(await ffprobe(['-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height,r_frame_rate:packet=pts_time,dts_time,size,flags:format=format_name', '-of', 'json', path]));
  const v = j.streams?.[0] ?? {};
  const [n, d] = String(v.r_frame_rate ?? '24/1').split('/').map(Number);
  const fps = d ? n / d : 24;
  const packets = (j.packets ?? []).map((p) => ({ dts: Number(p.dts_time ?? p.pts_time), pts: Number(p.pts_time ?? p.dts_time), bits: Number(p.size) * 8, key: String(p.flags).includes('K') }))
    .filter((p) => Number.isFinite(p.dts) && Number.isFinite(p.pts)).sort((a, b) => a.dts - b.dts);
  const profile = bitrateProfile(v.width ?? 0, v.height ?? 0);
  const issues = [];
  if (!/mp4/.test(j.format?.format_name ?? '') || extname(path) !== '.mp4') issues.push(`${where}: is not an MP4`);
  if (v.codec_name !== 'h264') issues.push(`${where}: is ${v.codec_name}, not H.264`);
  if (v.pix_fmt !== 'yuv420p') issues.push(`${where}: is ${v.pix_fmt}, not yuv420p`);
  if (!(await fastStart(path))) issues.push(`${where}: its index is at the end (no fast start)`);
  if (!packets.length) return [...issues, `${where}: has no video packets`];
  const first = Math.min(...packets.map((p) => p.pts));
  const seconds = Math.max(...packets.map((p) => p.pts)) - first + 1 / fps;
  const keys = packets.filter((p) => p.key).map((p) => p.pts - first).sort((a, b) => a - b);
  const gop = keys.length ? Math.max(keys[0], seconds - keys.at(-1), ...keys.slice(1).map((t, i) => t - keys[i])) : Infinity;
  if (gop > GOP_SECONDS + 1 / fps + 1e-3) issues.push(`${where}: ${Number.isFinite(gop) ? gop.toFixed(2) + ' s' : 'no keyframe'} between keyframes (at most ${GOP_SECONDS} s)`);
  const depth = profile.bufsize * (1 + TOLERANCE);
  let level = depth, then = packets[0].dts, low = depth;
  for (const p of packets) { level = Math.min(depth, level + (p.dts - then) * profile.maxrate); then = p.dts; level -= p.bits; low = Math.min(low, level); }
  if (low < 0) issues.push(`${where}: carries more than the ${profile.maxrate / 1e6} Mbps cap and its buffer allow for ${v.width}x${v.height}`);
  return issues;
}

async function stillIssues(path, where) {
  const head = readFileSync(path).subarray(0, 40);
  const issues = [];
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WEBP') issues.push(`${where}: is not WebP`);
  else if (head.toString('ascii', 12, 16) === 'VP8X' && (head[20] & 0x0c)) issues.push(`${where}: carries EXIF/XMP metadata`);
  return issues;
}

/** Every media reference in a world: [kind, value, set(newValue)]. */
function* mediaRefs(world) {
  for (const p of world.places) {
    for (const key of ['still', 'stillAfter']) if (p[key]) yield ['still', p[key], (v) => { p[key] = v; }];
    if (p.loop) yield ['film', p.loop, (v) => { p.loop = v; }];
    for (const h of p.hotspots) {
      if (h.film) yield ['film', h.film, (v) => { h.film = v; }];
      if (h.result) yield ['still', h.result, (v) => { h.result = v; }];
      for (const c of h.choices ?? []) {
        if (c.film) yield ['film', c.film, (v) => { c.film = v; }];
        if (c.result) yield ['still', c.result, (v) => { c.result = v; }];
      }
    }
  }
}
const servedStill = (src) => `served/stills/${basename(src, extname(src))}.webp`;
const servedFilm = (src, tier) => `served/films/${tier}/${basename(src)}`;

async function check() {
  const world = JSON.parse(readFileSync(SERVED, 'utf8'));
  const issues = [], seen = new Set();
  const tasks = [];
  for (const [kind, ref] of mediaRefs(world)) {
    for (const r of kind === 'film' ? Object.keys(TIERS).map((t) => ref.replace('/films/full/', `/films/${t}/`)) : [ref]) {
      if (seen.has(r)) continue;
      seen.add(r);
      const path = join(ROOT, r);
      if (!existsSync(path)) { issues.push(`${r}: is missing`); continue; }
      if (kind === 'still') tasks.push(() => stillIssues(path, r));
      else {
        if (!r.includes('/films/')) { issues.push(`${r}: a film served outside served/films/<tier>/`); continue; }
        tasks.push(() => filmIssues(path, r));
      }
    }
  }
  for (const [key, ref] of [['tiers', JSON.stringify(world.filmTiers)]]) if (ref !== JSON.stringify(Object.keys(TIERS))) issues.push(`np-world.json: ${key} is ${ref}`);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < tasks.length) issues.push(...await tasks[next++]()); }));
  return { issues, checked: seen.size };
}

async function build(jobs) {
  const world = JSON.parse(readFileSync(SOURCE, 'utf8'));
  for (const d of ['served/stills', ...Object.keys(TIERS).map((t) => `served/films/${t}`)]) mkdirSync(join(ROOT, d), { recursive: true });
  const work = new Map();
  for (const [kind, ref, set] of mediaRefs(world)) {
    if (kind === 'still') {
      const out = servedStill(ref);
      if (!existsSync(join(ROOT, out))) work.set(out, () => writeStill(join(ROOT, ref), join(ROOT, out)));
      set(out);
    } else {
      for (const tier of Object.keys(TIERS)) {
        const out = servedFilm(ref, tier);
        if (existsSync(join(ROOT, out)) || work.has(out)) continue;
        work.set(out, async () => {
          const size = TIERS[tier] ?? await probe(join(ROOT, ref));
          await encodeFilm(join(ROOT, ref), join(ROOT, out), { width: size.width, height: size.height });
        });
      }
      set(servedFilm(ref, 'full'));
    }
  }
  world.filmTiers = Object.keys(TIERS);
  const queue = [...work.entries()];
  console.log(`${queue.length} files to prepare`);
  const log = [];
  let next = 0, failed = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < queue.length) {
      const [out, job] = queue[next++];
      const t0 = Date.now();
      try { await job(); const s = ((Date.now() - t0) / 1000).toFixed(1); log.push({ out, seconds: Number(s) }); console.log(`ok ${out} ${s}s`); }
      catch (e) { failed++; console.error(`FAILED ${out}\n${e.message}`); }
    }
  }));
  if (log.length) writeFileSync(join(ROOT, 'served/encode-log.json'), JSON.stringify([...(existsSync(join(ROOT, 'served/encode-log.json')) ? JSON.parse(readFileSync(join(ROOT, 'served/encode-log.json'), 'utf8')) : []), ...log], null, 1));
  if (failed) { console.error(`${failed} failed; np-world.json not written`); process.exit(1); }
  writeFileSync(SERVED, JSON.stringify(world, null, 1) + '\n');
}

const args = process.argv.slice(2);
if (!args.includes('--check')) await build(Number(args[args.indexOf('--jobs') + 1]) || 3);
const { issues, checked } = await check();
if (issues.length) { console.error(issues.join('\n')); console.error(`${issues.length} delivery issue(s)`); process.exit(1); }
console.log(`delivery check: ${checked} served files OK`);
