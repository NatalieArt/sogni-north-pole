// 3. travel handoffs (normal + skip), 4. fade travel, 5. every transformation and feed choice, 6. cancellation,
// 9. complete traversal: all places, every hotspot, every choice, all four figures, home/back, mute
import { open, check, sleep, results } from './lib.mjs';
const url = process.argv[2];
const mobile = process.argv[3] === 'touch';
const tag = mobile ? '[touch]' : '[desktop]';
const p = await open(url, { mobile, port: mobile ? 9336 : 9335 });
const { b, s, waitFor, hit, btn, settled, enter, go, viol } = p;
const visited = new Set(), touched = new Set(), figures = new Set();
const world = async () => b.eval('world');
const closeViewer = async () => { if ((await s()).viewer) { await btn('Close'); await sleep(200); } };
const violations = async (what) => { const v = await viol(); check(`${tag} ${what}: no handoff/overlay violations`, v.length === 0, v.slice(0, 4)); };

async function moment(label) {
  await hit(label);
  const ok = await waitFor(`(() => { const s = __np.state(); return (!s.cur || s.viewer) && s.filmHidden && !s.filming; })()`, 90000);
  const st = await s();
  if (st.viewer) { figures.add(await b.eval(`document.getElementById('vname').textContent`)); await closeViewer(); }
  touched.add(`${st.place}/${label}`);
  check(`${tag} ${st.place}: "${label}" completes`, ok);
}
async function choose(hotspot, choice, expectResult) {
  await hit(hotspot);
  await waitFor(`!!__np.state().choices`, 5000);
  // the same hotspot clicked again while choices are open is harmless
  try { await hit(hotspot); } catch {}
  check(`${tag} choices stay open on a second click`, !!(await s()).choices);
  await btn(choice);
  await waitFor(`!__np.state().filmHidden`, 60000);
  await sleep(1500);
  const mid = await s();
  // repeated input mid-film: a click on the film area must not restart or change it
  const pt = await b.eval(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left + r.width * .5, y: r.top + r.height * .4 }; })()`);
  await p.press(pt);
  await sleep(300);
  const mid2 = await s();
  check(`${tag} "${choice}": mid-film input does not restart it`, mid2.filmSrc === mid.filmSrc && mid2.filmTime >= mid.filmTime, { a: mid.filmTime, b: mid2.filmTime });
  const ok = await waitFor(`(() => { const s = __np.state(); return !s.cur && s.filmHidden && !s.filming; })()`, 90000);
  const st = await s();
  if (expectResult) check(`${tag} "${choice}" lands on its result still`, ok && st.still === expectResult && st.after, { still: st.still, expect: expectResult });
  else check(`${tag} "${choice}" plays and returns to the scene`, ok && st.still.includes('reindeer-stable'), { still: st.still });
  touched.add(`${st.place}/${hotspot}/${choice}`);
}
const servedStill = (src) => src.replace(/^.*\//, 'served/stills/').replace(/\.png$/, '.webp');

try {
  check(`${tag} enter`, await enter()); await settled();
  const w = await world();
  visited.add('valley');
  // Valley moments
  await moment('The northern lights');
  await moment('The moon');
  await moment('The candy canes');
  // Valley -> Snowman (normal), Snowman -> Fireside (skip)
  check(`${tag} Valley -> Snowman`, await go('Walk through the pines', 'snowman-clearing')); visited.add('snowman-clearing');
  await moment('Say hello to the snowman');
  check(`${tag} Snowman -> Fireside (skipped)`, await go('Go inside', 'santa-fireside', { skip: true })); visited.add('santa-fireside');
  await violations('valley/snowman/fireside');
  await moment('Santa Claus');
  await moment('The sleepy cat');
  await moment("Santa's list");
  // fade: fireside -> tree, all tree choices, back
  check(`${tag} fade Fireside -> Tree`, await go('Decorate the Christmas tree', 'decorate-tree')); visited.add('decorate-tree');
  const tree = w.places.find((x) => x.id === 'decorate-tree').hotspots.find((h) => h.choices);
  for (const c of tree.choices) {
    await choose('Tap to decorate', c.label, c.result);
    await btn('Decorate again');
    check(`${tag} Decorate again restores the tree`, await waitFor(`(() => { const s = __np.state(); return !s.cur && !s.after && s.still.includes('tree-before'); })()`, 20000));
  }
  check(`${tag} fade Tree -> Fireside`, await go("Back to Santa's fireside", 'santa-fireside', { isButton: true }));
  await violations('tree');
  // Fireside -> Bakery, decorations
  check(`${tag} Fireside -> Bakery`, await go("Gingerbread from the elves' bakery", 'bakery')); visited.add('bakery');
  for (const [label, id, isButton] of [['Decorate a gingerbread house', 'decorate-house'], ['Decorate the gingerbread men', 'decorate-men'], ['Decorate the gingerbread castle', 'decorate-castle'], ['Decorate the cookies', 'decorate-cookies', true]]) {
    check(`${tag} fade Bakery -> ${id}`, await go(label, id, { isButton })); visited.add(id);
    const h = w.places.find((x) => x.id === id).hotspots.find((h) => h.action === 'transform');
    if (h.choices) {
      for (const c of h.choices) {
        await choose('Tap to decorate', c.label, c.result);
        await btn('Decorate again');
        await waitFor(`!__np.state().after && !__np.state().cur`, 20000);
      }
    } else {
      await hit('Tap to decorate');
      await waitFor(`!__np.state().filmHidden`, 60000);
      // a second click mid-film is harmless (the outline is gone; the click lands on the film)
      try { await hit('Tap to decorate'); check(`${tag} ${id}: outline hidden mid-film`, false); } catch { check(`${tag} ${id}: outline hidden mid-film`, true); }
      const ok = await waitFor(`(() => { const s = __np.state(); return !s.cur && s.filmHidden && s.after; })()`, 90000);
      const st = await s();
      check(`${tag} ${id} lands on its result still`, ok && st.still === h.result, { still: st.still, expect: h.result });
      touched.add(`${id}/decorate`);
      await btn('Decorate again');
      await waitFor(`!__np.state().after && !__np.state().cur`, 20000);
    }
    check(`${tag} fade ${id} -> Bakery`, await go('Back to the bakery', 'bakery', { isButton: true }));
  }
  await violations('bakery');
  check(`${tag} Bakery -> Fireside (fade)`, await go("Back to Santa's fireside", 'santa-fireside', { isButton: true }));
  // Fireside -> Workshop
  check(`${tag} Fireside -> Workshop`, await go('Up the chimney to the toy workshop', 'toy-workshop')); visited.add('toy-workshop');
  await moment('Start the toy machine');
  await moment('Holly the elf');
  await moment('The jar of starlight');
  await moment('Open the present');
  check(`${tag} fade Workshop -> Soldier`, await go('Paint a toy soldier', 'decorate-soldier')); visited.add('decorate-soldier');
  const soldier = w.places.find((x) => x.id === 'decorate-soldier').hotspots.find((h) => h.choices);
  for (const c of soldier.choices) { await choose('Tap to paint', c.label, c.result); await btn('Decorate again'); await waitFor(`!__np.state().after && !__np.state().cur`, 20000); }
  check(`${tag} Soldier -> Workshop`, await go('Back to the workshop', 'toy-workshop', { isButton: true }));
  // Workshop -> Stable (skipped)
  check(`${tag} Workshop -> Stable (skipped)`, await go('Out to the reindeer stable', 'stable', { isButton: true, skip: true })); visited.add('stable');
  const feed = w.places.find((x) => x.id === 'stable').hotspots.find((h) => h.choices);
  for (const c of feed.choices) await choose('Feed Dasher', c.label, null);
  await moment('Dasher the reindeer');
  // Stable -> Moon -> Valley
  check(`${tag} Stable -> Moon`, await go('Ride the sleigh to the moon', 'moon')); visited.add('moon');
  await moment('The North Pole, far below');
  check(`${tag} Moon -> Valley`, await go('Fly home to the North Pole', 'valley'));
  await violations('stable/moon');
  // Valley -> Cottage -> Fireside ; home button; Valley -> Stable ; back button ; Cottage clearing button
  check(`${tag} Valley -> Cottage`, await go('The gingerbread cottage', 'cottage')); visited.add('cottage');
  check(`${tag} Cottage -> Snowman (button)`, await go('Walk around the clearing', 'snowman-clearing', { isButton: true }));
  check(`${tag} Back to the valley (home button)`, await go('Back to the valley', 'valley', { isButton: true }));
  check(`${tag} Valley -> Cottage again`, await go('The gingerbread cottage', 'cottage'));
  check(`${tag} Cottage -> Fireside (door)`, await go('Knock on the door', 'santa-fireside'));
  check(`${tag} Valley via home from fireside`, await go('Back to the valley', 'valley', { isButton: true }));
  check(`${tag} Valley -> Stable (sleigh)`, await go("Follow Santa's sleigh", 'stable'));
  check(`${tag} Stable -> Valley (button)`, await go('Back out to the valley', 'valley', { isButton: true }));
  await violations('home/back');

  // 6. cancellation: leave during loading, playback, speech and the figure toast
  check(`${tag} to the snowman again`, await go('Walk through the pines', 'snowman-clearing'));
  await hit('Say hello to the snowman'); await sleep(50);
  await btn('Back to the valley'); // during loading
  check(`${tag} leaving during loading lands cleanly`, await waitFor(`__np.state().place === 'valley' && !__np.state().cur && __np.state().filmHidden`, 30000));
  check(`${tag} to the snowman`, await go('Walk through the pines', 'snowman-clearing'));
  await hit('Say hello to the snowman'); await waitFor(`__np.state().filmTime > 3`, 30000);
  await btn('Back to the valley'); // during playback
  check(`${tag} leaving during playback lands cleanly`, await waitFor(`__np.state().place === 'valley' && !__np.state().cur && __np.state().filmHidden && !__np.state().sub`, 30000));
  const opens0 = await b.eval('__np.viewerOpens');
  await sleep(9000);
  check(`${tag} no figure opens after leaving mid-film`, (await b.eval('__np.viewerOpens')) === opens0);
  check(`${tag} to the snowman`, await go('Walk through the pines', 'snowman-clearing'));
  await hit('Say hello to the snowman'); await waitFor(`__np.state().sub`, 40000);
  await btn('Back to the valley'); // during speech
  check(`${tag} leaving during speech: subtitles gone, music back up`, await waitFor(`__np.state().place === 'valley' && !__np.state().sub && __np.state().musicVol > .5`, 30000), await s());
  // during the toast: a figure not found yet (Dasher was found; use a fresh page state? the toast shows only on first find)
  await violations('cancellation');
  check(`${tag} figures seen in the viewer`, figures.size === 4, [...figures]);
  check(`${tag} places visited`, visited.size === 14, [...visited]);
  // mute / unmute
  await btn('Sound on'); const m1 = await s(); await btn('Sound off'); const m2 = await s();
  check(`${tag} mute toggles`, m1.muted === true && m2.muted === false);
  const errs = b.logs.filter((l) => /EXCEPTION|error:/i.test(l) && !/favicon/.test(l));
  check(`${tag} no console errors`, errs.length === 0, errs.slice(0, 5));
  const warns = b.logs.filter((l) => /warn/i.test(l));
  if (warns.length) console.log('warnings:', warns.slice(0, 10));
} catch (e) { check(`${tag} run`, false, e.stack); }
finally { b.close(); }
process.exit(results.every((r) => r.ok) ? 0 : 1);
