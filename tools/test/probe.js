// injected into the player page before Enter: records handoffs and flags any violation as it happens
window.__np = (() => {
  const log = [], viol = [];
  const T = () => Math.round(performance.now());
  const expectStill = () => (place ? (after && place.stillAfter ? (afterSrc ?? place.stillAfter) : place.still) : null);
  const stillReady = () => still.getAttribute('src') === expectStill() && still.complete && still.naturalWidth > 0;
  new MutationObserver(() => {
    const ok = stillReady();
    log.push([T(), 'title', $('title').textContent, ok]);
    if (!ok) viol.push([T(), 'title changed over a picture that is not the new scene', $('title').textContent, still.getAttribute('src')]);
  }).observe($('title'), { childList: true, characterData: true, subtree: true });
  let filmShown = false;
  new MutationObserver(() => {
    const hidden = film.classList.contains('hidden');
    if (!hidden && !filmShown) { filmShown = true; log.push([T(), 'film shown', film.dataset.src]); }
    if (hidden && filmShown) {
      filmShown = false;
      const ok = stillReady();
      log.push([T(), 'film hidden', place?.id, ok]);
      if (!ok) viol.push([T(), 'film taken down over a still that is not ready', still.getAttribute('src'), expectStill()]);
    }
  }).observe(film, { attributes: true, attributeFilter: ['class'] });
  let viewerOpens = 0;
  new MutationObserver(() => { if (!$('viewer').classList.contains('hidden')) { viewerOpens++; log.push([T(), 'viewer', $('vname').textContent, place?.id]); } })
    .observe($('viewer'), { attributes: true, attributeFilter: ['class'] });
  let lastStill = null;
  setInterval(() => {
    const filmUp = !film.classList.contains('hidden') && Number(getComputedStyle(film).opacity) > 0.5;
    if (filmUp && getComputedStyle(hot).visibility !== 'hidden') viol.push([T(), 'outlines visible over a film']);
    if (filmUp && !tip.classList.contains('hidden') && getComputedStyle(tip).visibility !== 'hidden') viol.push([T(), 'label visible over a film']);
    const s = still.getAttribute('src');
    if (s !== lastStill) { log.push([T(), 'still src', s]); lastStill = s; }
  }, 50);
  const point = (label) => {
    const g = [...hot.querySelectorAll('g')].find((g) => g.getAttribute('aria-label') === label);
    if (!g) return null;
    const r = g.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const pts = [];
    for (let i = 1; i < 24; i++) for (let j = 1; j < 24; j++) pts.push([r.left + r.width * i / 24, r.top + r.height * j / 24]);
    pts.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    const on = (x, y) => { const e = document.elementFromPoint(x, y); return e && e.closest('g') === g; };
    // a finger is not a pixel: prefer a point well inside the shape (everything within 8 px is the same object)
    for (const [x, y] of pts) if (on(x, y) && [[8, 0], [-8, 0], [0, 8], [0, -8], [6, 6], [-6, -6], [6, -6], [-6, 6]].every(([dx, dy]) => on(x + dx, y + dy))) return { x, y };
    for (const [x, y] of pts) if (on(x, y)) return { x, y };
    return null;
  };
  const button = (text) => {
    const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text && b.offsetParent !== null && getComputedStyle(b).visibility !== 'hidden');
    if (!b) return null;
    const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const state = () => ({
    place: place?.id, title: $('title').textContent, after, cur: current?.key ?? null, curKind: current?.kind ?? null,
    filming: stage.classList.contains('filming'), journey: stage.classList.contains('journey'), filmHidden: film.classList.contains('hidden'),
    filmSrc: film.dataset.src ?? null, filmTime: film.currentTime, filmPaused: film.paused, hotVis: getComputedStyle(hot).visibility,
    still: still.getAttribute('src'), loopHidden: loop.classList.contains('hidden'), loopSrc: loop.dataset.src ?? null, loopPaused: loop.paused,
    viewer: !$('viewer').classList.contains('hidden'), toast: !$('toast').classList.contains('hidden'), sub: !sub.classList.contains('hidden'),
    notice: $('notice').classList.contains('hidden') ? null : $('notice').textContent, busy: !$('busy').classList.contains('hidden'), tier, idle, hinting,
    fader: $('fader').classList.contains('on'), menu: [...menu.querySelectorAll('button')].map((b) => b.textContent),
    hotspots: [...hot.querySelectorAll('g')].map((g) => g.getAttribute('aria-label')),
    choices: choices.classList.contains('hidden') ? null : [...choices.querySelectorAll('button')].map((b) => b.textContent),
    cached: [...cache.keys()], musicVol: Number(music.volume.toFixed(2)), loopVol: loop.volume, musicKey: music.dataset.key, muted,
  });
  return { log, viol, point, button, state, get viewerOpens() { return viewerOpens; } };
})();
