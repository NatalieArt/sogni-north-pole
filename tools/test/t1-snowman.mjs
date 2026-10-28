// 1. Snowman repeated input, 2. hints during playback (desktop or touch: argv[3] === 'touch')
import { open, check, sleep, results } from './lib.mjs';
const url = process.argv[2];
const mobile = process.argv[3] === 'touch';
const tag = mobile ? '[touch]' : '[desktop]';
const p = await open(url, { mobile, port: mobile ? 9334 : 9333 });
const { b, s, waitFor, hit, settled, enter, go, viol } = p;
try {
  check(`${tag} enter lands on the valley`, await enter());
  await settled();
  check(`${tag} valley -> snowman`, await go('Walk through the pines', 'snowman-clearing'));
  await settled();
  // rapid clicks during loading
  await hit('Say hello to the snowman');
  await sleep(30);
  const loadingState = await s();
  await b.eval('0'); // keep order
  try { await hit('Say hello to the snowman'); } catch (e) { /* outline already hidden: the click lands on the film, which is fine */ }
  try { await hit('Say hello to the snowman'); } catch {}
  check(`${tag} outlines hidden as soon as the film is chosen`, loadingState.filming && loadingState.hotVis === 'hidden', loadingState);
  check(`${tag} film starts`, await waitFor(`!__np.state().filmHidden && __np.state().filmTime > 0.2`, 30000));
  // midway clicks: on the snowman's place (now the film) and via keyboard H / idle
  await waitFor(`__np.state().filmTime > 4`, 20000);
  const mid = await s();
  const pt = await b.eval(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left + r.width * .3, y: r.top + r.height * .5 }; })()`);
  await p.press(pt); await p.press(pt);
  await b.move(pt.x + 5, pt.y + 5);
  await b.key('h');
  await sleep(300);
  const after = await s();
  check(`${tag} midway clicks do not restart the film`, after.filmTime >= mid.filmTime && after.filmSrc === mid.filmSrc, { before: mid.filmTime, after: after.filmTime });
  check(`${tag} H during the film keeps outlines hidden`, after.hotVis === 'hidden' && after.hinting === true, { hotVis: after.hotVis });
  await b.key('h'); // hints off again
  // idle hint must not fire during the film (wait past 6 s without input)
  await sleep(1500);
  // the spoken line follows the film
  check(`${tag} the line follows the film`, await waitFor(`__np.state().sub`, 20000));
  const speaking = await s();
  await sleep(500);
  try { await hit('Say hello to the snowman'); } catch {}
  await sleep(300);
  const speaking2 = await s();
  check(`${tag} a click during the line does not restart anything`, speaking2.sub && speaking2.cur === speaking.cur && speaking2.filmHidden, { cur: speaking2.cur });
  check(`${tag} the figure viewer opens once`, await waitFor(`__np.state().viewer`, 30000));
  await sleep(1000);
  const opens = await b.eval('__np.viewerOpens');
  check(`${tag} viewer opened exactly once`, opens === 1, { opens });
  await p.btn('Close');
  await settled();
  // deliberate replay after completion
  await hit('Say hello to the snowman');
  check(`${tag} deliberate replay plays the film again from the start`, await waitFor(`!__np.state().filmHidden && __np.state().filmTime < 3 && __np.state().filmTime > 0`, 30000));
  await settled(60000);
  const v = await viol();
  check(`${tag} no handoff or overlay violations`, v.length === 0, v.slice(0, 5));
  const errs = b.logs.filter((l) => /EXCEPTION|error:/i.test(l) && !/favicon/.test(l));
  check(`${tag} no console errors`, errs.length === 0, errs.slice(0, 5));
} catch (e) { check(`${tag} run`, false, e.message); }
finally { b.close(); }
process.exit(results.every((r) => r.ok) ? 0 : 1);
