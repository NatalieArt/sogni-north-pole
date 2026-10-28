// shared steps for the player tests
import { readFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';
export { sleep };
const PROBE = readFileSync(new URL('./probe.js', import.meta.url), 'utf8');

export const results = [];
export function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}

export async function open(url, { mobile = false, width = 1440, height = 900, port = 9333, before } = {}) {
  const b = await launch({ port, width, height });
  if (mobile) await b.viewport(390, 844, true); else await b.viewport(width, height, false);
  if (before) await before(b);
  await b.goto(url);
  await b.eval(PROBE);
  const s = () => b.eval('__np.state()');
  const waitFor = async (expr, ms = 30000, every = 100) => {
    const t0 = Date.now();
    for (;;) {
      const v = await b.eval(expr).catch(() => false);
      if (v) return v;
      if (Date.now() - t0 > ms) return false;
      await sleep(every);
    }
  };
  const press = async (pt) => (mobile ? b.tap(pt.x, pt.y) : b.click(pt.x, pt.y));
  const hit = async (label) => {
    const pt = await b.eval(`__np.point(${JSON.stringify(label)})`);
    if (!pt) throw new Error(`no visible hotspot "${label}"`);
    await press(pt); return pt;
  };
  const btn = async (text) => {
    const pt = await b.eval(`__np.button(${JSON.stringify(text)})`);
    if (!pt) throw new Error(`no visible button "${text}"`);
    await press(pt); return pt;
  };
  // the scene is settled: nothing running, no film, no fade
  const settled = (ms = 60000) => waitFor(`(() => { const s = __np.state(); return !s.cur && s.filmHidden && !s.fader && !s.filming && !s.journey; })()`, ms);
  const enter = async () => { await btn('Enter'); return waitFor(`document.getElementById('intro').classList.contains('gone') && __np.state().title === 'Aurora Valley'`, 60000); };
  // travel by a hotspot or button and wait for the landing
  const go = async (labelOrButton, to, { skip = false, isButton = false } = {}) => {
    if (isButton) await btn(labelOrButton); else await hit(labelOrButton);
    if (skip) {
      await waitFor(`!__np.state().filmHidden`, 60000);
      await sleep(600);
      const st = await s();
      await press({ x: (await b.eval('innerWidth')) / 2, y: (await b.eval('innerHeight')) / 2 });
      void st;
    }
    const ok = await waitFor(`__np.state().place === ${JSON.stringify(to)} && !__np.state().cur && __np.state().filmHidden && !__np.state().fader`, 120000);
    return ok;
  };
  const viol = () => b.eval('__np.viol.splice(0)');
  return { b, s, waitFor, hit, btn, press, settled, enter, go, viol, mobile };
}
