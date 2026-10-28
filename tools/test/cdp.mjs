// minimal Chrome DevTools Protocol driver: headless Chrome, one page
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333, width = 1440, height = 900 } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'np-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', `--window-size=${width},${height}`, '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 50; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === 'page')) break; } catch {}
    await sleep(200);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map(), listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { r, j } = pending.get(msg.id); pending.delete(msg.id); msg.error ? j(new Error(JSON.stringify(msg.error))) : r(msg.result); }
    else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
  const logs = [];
  listeners.push((m) => {
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (m.method === 'Runtime.exceptionThrown') logs.push(`EXCEPTION: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    if (m.method === 'Log.entryAdded') logs.push(`log ${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  });
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable'); await send('Log.enable');
  const requests = [];
  listeners.push((m) => {
    if (m.method === 'Network.requestWillBeSent') requests.push({ id: m.params.requestId, url: m.params.request.url, t: m.params.timestamp, type: m.params.type });
    if (m.method === 'Network.loadingFinished') { const q = requests.find((x) => x.id === m.params.requestId); if (q) { q.done = m.params.timestamp; q.bytes = m.params.encodedDataLength; } }
    if (m.method === 'Network.loadingFailed') { const q = requests.find((x) => x.id === m.params.requestId); if (q) { q.failed = m.params.errorText; q.done = m.params.timestamp; } }
  });
  const api = {
    send, logs, requests, listeners,
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async goto(url) { await send('Page.navigate', { url }); await sleep(800); for (let i = 0; i < 50 && (await api.eval('document.readyState')) !== 'complete'; i++) await sleep(100); },
    async viewport(w, h, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
    },
    // constrained link: down/up in Mbps, latency in ms
    async throttle(down, latency = 0) {
      if (!down) return send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      return send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: down * 125000, uploadThroughput: 1.5 * 125000 });
    },
    block: (patterns) => send('Network.setBlockedURLs', { urls: patterns }),
    clearCache: () => send('Network.clearBrowserCache'),
    async shot(path) { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path, Buffer.from(r.data, 'base64')); },
    async click(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    async move(x, y) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); },
    async tap(x, y) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x, y }] });
    },
    async key(key, code = key) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: key === 'Enter' ? 13 : key === ' ' ? 32 : key === 'Tab' ? 9 : key.toUpperCase().charCodeAt(0), text: key.length === 1 ? key : key === 'Enter' ? '\r' : undefined });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
    },
    close() { try { ws.close(); } catch {} proc.kill(); },
  };
  return api;
}
