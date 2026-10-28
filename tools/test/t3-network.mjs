// 7. loading and failure, constrained link, fetch-ahead waterfall, stall switch, rejected playback,
// 6. toast-delay cancellation, 2. idle hint timing, keyboard activation, skip timing
import { writeFileSync, mkdirSync } from 'node:fs';
import { open, check, sleep, results } from './lib.mjs';
const url = process.argv[2];
const out = (process.env.FRAMES ?? new URL('./frames/', import.meta.url).pathname); mkdirSync(out, { recursive: true });

// ---- A. cold cache on a constrained link (4 Mbps down, 150 ms) ----
{
  const p = await open(url, { port: 9341, before: async (b) => { await b.clearCache(); await b.throttle(4, 150); } });
  const { b, s, waitFor, hit, settled, enter, go, viol } = p;
  try {
    const t0 = Date.now();
    check('[4 Mbps cold] enter lands on the valley', await enter(), `${((Date.now() - t0) / 1000).toFixed(1)} s`);
    // record frames while travelling, to look at the handoff
    let n = 0;
    const frames = [];
    b.listeners.push((m) => { if (m.method === 'Page.screencastFrame') { frames.push(m.params.data); b.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }); } });
    // an immediate cold click: nothing fetched ahead yet
    const t1 = Date.now();
    await b.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 720, everyNthFrame: 2 });
    check('[4 Mbps cold] immediate click Valley -> Snowman lands', await go('Walk through the pines', 'snowman-clearing'), `${((Date.now() - t1) / 1000).toFixed(1)} s`);
    await b.send('Page.stopScreencast');
    for (const f of frames) writeFileSync(`${out}/cold-valley-snowman-${String(n++).padStart(3, '0')}.jpg`, Buffer.from(f, 'base64'));
    const st = await s();
    check('[4 Mbps cold] films switched to 720p after measuring the link', st.tier === '720', st.tier);
    // fetch-ahead: wait idle, then look at what was requested before any click
    const before = b.requests.length;
    await sleep(20000);
    const ahead = b.requests.slice(before).filter((r) => /served\/(films|stills)/.test(r.url)).map((r) => ({ url: r.url.replace(/^.*served\//, ''), s: r.done ? ((r.done - r.t)).toFixed(1) : 'pending', kB: r.bytes ? Math.round(r.bytes / 1024) : null, failed: r.failed }));
    console.log('fetch-ahead at the snowman (no click yet):', JSON.stringify(ahead));
    check('[4 Mbps] the snowman scene fetches its next films before any click', ahead.some((r) => /films\/720\/np-final-fun-snowman/.test(r.url)), ahead.map((r) => r.url));
    // the click now plays local bytes: first frame quickly
    const t2 = Date.now();
    await hit('Say hello to the snowman');
    await waitFor(`!__np.state().filmHidden`, 60000, 20);
    check('[4 Mbps] a fetched-ahead film shows its first frame fast', Date.now() - t2 < 1500, `${Date.now() - t2} ms`);
    await settled(90000);
    if ((await s()).viewer) await p.btn('Close');
    // skip timing on a constrained link
    const t3 = Date.now();
    frames.length = 0; n = 0;
    await b.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 720, everyNthFrame: 2 });
    check('[4 Mbps] Snowman -> Fireside skipped', await go('Go inside', 'santa-fireside', { skip: true }), `${((Date.now() - t3) / 1000).toFixed(1)} s`);
    await b.send('Page.stopScreencast');
    for (const f of frames) writeFileSync(`${out}/skip-snowman-fireside-${String(n++).padStart(3, '0')}.jpg`, Buffer.from(f, 'base64'));
    check('[4 Mbps] fade Fireside -> Tree waits for its picture', await go('Decorate the Christmas tree', 'decorate-tree'));
    check('[4 Mbps] fade Tree -> Fireside', await go("Back to Santa's fireside", 'santa-fireside', { isButton: true }));
    const v = await viol();
    check('[4 Mbps] no handoff/overlay violations', v.length === 0, v.slice(0, 5));
    const errs = b.logs.filter((l) => /EXCEPTION|error:/i.test(l) && !/favicon/.test(l));
    check('[4 Mbps] no console errors', errs.length === 0, errs.slice(0, 5));
  } catch (e) { check('[4 Mbps] run', false, e.stack); }
  finally { b.close(); }
}

// ---- B–H. failures and edge cases on the normal link ----
{
  const p = await open(url, { port: 9342 });
  const { b, s, waitFor, hit, btn, settled, enter, go, viol } = p;
  try {
    await enter(); await settled();
    // H. idle hint: once, briefly, then nothing until input
    check('[hint] idle hint shows after 6 quiet seconds', await waitFor(`__np.state().idle`, 9000));
    check('[hint] and goes away by itself', await waitFor(`!__np.state().idle`, 6000));
    await sleep(4000);
    check('[hint] and does not come back without new input', !(await s()).idle);
    // B. a film that will not load: retried, then 720p, then the visitor is asked
    await b.block(['*np-final-wonder-aurora.mp4']);
    await b.eval(`cache.clear(); failedFetch.clear()`); await b.clearCache();
    await hit('The northern lights');
    check('[fail film] the visitor is told and offered a way on', await waitFor(`(__np.state().notice || '').includes('did not load')`, 30000), (await s()).notice);
    await btn('Skip it');
    check('[fail film] Skip returns to the scene', await waitFor(`(() => { const s = __np.state(); return !s.cur && s.filmHidden && !s.filming && s.place === 'valley' && s.hotVis === 'visible'; })()`, 10000));
    await b.eval(`cache.clear(); failedFetch.clear()`);
    await hit('The northern lights');
    await waitFor(`(__np.state().notice || '').includes('did not load')`, 30000);
    await b.block([]);
    await btn('Try again');
    check('[fail film] Try again plays the film once it loads', await waitFor(`!__np.state().filmHidden && __np.state().filmTime > 1`, 30000));
    await settled(60000);
    // C. a still that will not load: the journey film holds its last frame, the visitor is asked
    await b.block(['*np-approved-scene-snowman-cottage.webp']);
    await b.eval(`stills.clear()`); await b.clearCache();
    await hit('Walk through the pines');
    check('[fail still] the visitor is told the scene did not load', await waitFor(`(__np.state().notice || '').includes('scene did not load')`, 60000));
    const held = await s();
    check('[fail still] the old scene is not revealed meanwhile', held.place === 'valley' && !held.filmHidden && held.title === 'Aurora Valley' && held.hotVis === 'hidden', { place: held.place, filmHidden: held.filmHidden, title: held.title });
    await b.block([]);
    await btn('Try again');
    check('[fail still] Try again lands on the snowman', await waitFor(`__np.state().place === 'snowman-clearing' && !__np.state().cur && __np.state().filmHidden`, 30000));
    // D. rejected playback
    await b.eval(`(() => { const real = HTMLMediaElement.prototype.play; let once = true; HTMLMediaElement.prototype.play = function () { if (once && this.id === 'film') { once = false; return Promise.reject(new DOMException('blocked', 'NotAllowedError')); } return real.call(this); }; })()`);
    await hit('Say hello to the snowman');
    check('[rejected play] the visitor gets a Play button', await waitFor(`(__np.state().notice || '').includes('Tap to play')`, 15000));
    await btn('Play');
    check('[rejected play] Play starts the film', await waitFor(`!__np.state().filmHidden && __np.state().filmTime > 1`, 20000));
    // F. leaving during the figure toast (snowman not found yet in this page)
    check('[toast] the toast appears', await waitFor(`__np.state().toast`, 40000));
    await btn('Back to the valley');
    await sleep(3000);
    const tst = await s();
    check('[toast] leaving during the toast opens no figure over the new scene', !tst.viewer && (await b.eval('__np.viewerOpens')) === 0 && tst.place === 'valley', { viewer: tst.viewer, place: tst.place });
    check('[toast] music level recovers', await waitFor(`__np.state().musicVol > .5`, 5000));
    // E. a stalled full-size film switches to 720p where it is
    await b.eval(`tier = 'full'`);
    check('[stall] to the snowman', await go('Walk through the pines', 'snowman-clearing'));
    await b.eval(`cache.clear()`);
    await b.clearCache();
    await b.throttle(0.4, 150);
    await hit('Say hello to the snowman');
    check('[stall] Loading… is shown while the film waits', await waitFor(`__np.state().busy`, 15000, 50));
    check('[stall] a starved full-size film switches to 720p', await waitFor(`(__np.state().filmSrc || '').includes('/720/')`, 40000), (await s()).filmSrc);
    await b.throttle(0);
    check('[stall] and plays on to the end', await settled(90000));
    if ((await s()).viewer) await btn('Close');
    // G. keyboard: a hotspot is reachable with Tab and runs with Enter
    await b.eval(`document.activeElement?.blur?.()`);
    let focused = '';
    for (let i = 0; i < 12 && !focused.includes('Say hello'); i++) { await b.key('Tab'); focused = await b.eval(`document.activeElement === document.body ? '(body)' : (document.activeElement?.getAttribute?.('aria-label') || document.activeElement?.textContent || '')`); console.log('focus', i, focused.slice(0, 40)); }
    check('[keyboard] Tab reaches the snowman', focused.includes('Say hello'), focused);
    await b.key('Enter');
    check('[keyboard] Enter runs it', await waitFor(`__np.state().curKind === 'play'`, 5000));
    await settled(60000);
    const v = await viol();
    check('[edge] no handoff/overlay violations', v.length === 0, v.slice(0, 5));
    const errs = b.logs.filter((l) => /EXCEPTION/i.test(l));
    check('[edge] no exceptions', errs.length === 0, errs.slice(0, 5));
    console.log('console warnings (expected for the injected failures):', b.logs.filter((l) => /warn|error/i.test(l)).slice(0, 12));
  } catch (e) { check('[edge] run', false, e.stack); }
  finally { b.close(); }
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
