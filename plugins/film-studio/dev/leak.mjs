// Whether a film's pages can reach anything outside their folder, in an
// OpenFilm package: node dev/leak.mjs <openfilm package folder> [browser]
//
// A page tries every way out it has at traps this script listens on (another
// port of this computer, its network address, a STUN port, a made-up name),
// drawn as look and render draw it, and played by an ordinary browser (the
// second argument, else the drawing browser) as the editor's preview is. What
// the traps were asked is what got out. With an OpenFilm that is not patched
// it must find leaks: that is what says the test works.
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { createServer as tcp } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = resolve(process.argv[2]);
const browserPath = process.argv[3];
const own = Object.values(networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address;
const hits = [];
let mode = '';
const note = (what) => { if (!hits.some((h) => h.mode === mode && h.what === what)) hits.push({ mode, what }); };
const trap = createServer((req, res) => { if (req.url !== '/favicon.ico') note(req.url.split('?')[0]); res.writeHead(200, { 'access-control-allow-origin': '*' }).end('x'); });
trap.on('upgrade', (req, socket) => { note(req.url); socket.destroy(); });
await new Promise((done) => trap.listen(0, '0.0.0.0', done));
const port = trap.address().port;
// a bare connection (preconnect) says nothing: only counted
const bare = tcp((socket) => { note('/preconnect'); socket.on('error', () => {}); socket.destroy(); });
await new Promise((done) => bare.listen(0, '0.0.0.0', done));
const stun = createSocket('udp4');
stun.on('message', () => note('/webrtc-stun'));
await new Promise((done) => stun.bind(0, '0.0.0.0', done));
const stun2 = createSocket('udp4');
stun2.on('message', () => note('/webrtc-stun-through-a-blank-frame'));
await new Promise((done) => stun2.bind(0, '0.0.0.0', done));

const to = [['loop', `127.0.0.1:${port}`], ...(own ? [['lan', `${own}:${port}`]] : [])];
const page = `<!doctype html><meta charset=utf-8>
${to.map(([n, a]) => `<link rel=stylesheet href="http://${a}/${n}-css"><link rel=prefetch href="http://${a}/${n}-prefetch">
<script src="http://${a}/${n}-script"></script><img src="http://${a}/${n}-img"><video src="http://${a}/${n}-video" preload=auto></video>
<iframe src="http://${a}/${n}-iframe"></iframe><object data="http://${a}/${n}-object"></object>
<style>@font-face{font-family:${n};src:url(http://${a}/${n}-font)}</style><p style="font-family:${n}">x</p>`).join('\n')}
<link rel=preconnect href="http://${own ?? '127.0.0.1'}:${bare.address().port}">
<body><form id=f action="http://${to[0][1]}/loop-form" target=t><input name=a></form><iframe name=t></iframe><div id=d></div><script>
const quiet = (f) => { try { const r = f(); if (r && r.catch) r.catch(() => {}); } catch {} };
for (const [n, a] of ${JSON.stringify(to)}) {
  quiet(() => fetch('http://' + a + '/' + n + '-fetch'));
  quiet(() => fetch('http://' + a + '/' + n + '-nocors', { mode: 'no-cors' }));
  quiet(() => navigator.sendBeacon('http://' + a + '/' + n + '-beacon', 'x'));
  quiet(() => new EventSource('http://' + a + '/' + n + '-events'));
  quiet(() => new WebSocket('ws://' + a + '/' + n + '-ws'));
  quiet(() => { const x = new XMLHttpRequest(); x.open('GET', 'http://' + a + '/' + n + '-xhr'); x.send(); });
  quiet(() => new Worker(URL.createObjectURL(new Blob(["fetch('http://" + a + "/" + n + "-worker').catch(()=>{});new WebSocket('ws://" + a + "/" + n + "-workerws')"]))));
  quiet(() => import('http://' + a + '/' + n + '-import'));
  quiet(() => { const i = document.createElement('iframe'); i.srcdoc = '<img src="http://' + a + '/' + n + '-srcdoc">'; document.body.append(i); });
  quiet(() => { const w = window.open('http://' + a + '/' + n + '-popup'); });
}
quiet(() => document.getElementById('f').submit());
quiet(() => { const c = new RTCPeerConnection({ iceServers: [{ urls: 'stun:${own ?? '127.0.0.1'}:${stun.address().port}' }] }); c.createDataChannel('x'); c.createOffer().then((o) => c.setLocalDescription(o)); });
quiet(() => { const i = document.createElement('iframe'); document.body.append(i); const c = new i.contentWindow.RTCPeerConnection({ iceServers: [{ urls: 'stun:${own ?? '127.0.0.1'}:${stun2.address().port}' }] }); c.createDataChannel('x'); c.createOffer().then((o) => c.setLocalDescription(o)); });
window.film = { duration: 1, frame(t) { d.textContent = 'drawn ' + t; } };
</script>`;

const folder = mkdtempSync(join(tmpdir(), 'film-leak-'));
mkdirSync(join(folder, '.film'));
writeFileSync(join(folder, '.film', 'opened'), '');
writeFileSync(join(folder, 'page.html'), page);
const filmOf = (clip) => `<meta name="viewport" content="width=320, height=180">\n<section>\n${clip}\n</section>\n`;
writeFileSync(join(folder, 'film.html'), filmOf('<iframe src="page.html#t=0,1"></iframe>'));

const load = (file) => import(pathToFileURL(join(pkg, file)).href);
const { look } = await load('src/look.mjs');
const { render } = await load('src/render.mjs');
const { launch, serve } = await load('src/host.mjs');
const settle = (ms = 2500) => new Promise((done) => setTimeout(done, ms));
process.chdir(folder);
const tried = async (name, work) => {
  mode = name;
  try { await work(); } catch (error) { console.log(`  (${name}: ${String(error.message).split('\n')[0].slice(0, 110)})`); }
  await settle();
};
await tried('look', () => look(['0.5'], {}));
await tried('render', () => render(['0-0.2'], { workers: 1 }));
for (const [n, a] of to) {
  for (const [kind, clip] of [['video', `<video src="http://${a}/${n}-clip-video#t=0,1"></video>`], ['audio', `<audio src="http://${a}/${n}-clip-audio#t=0,1"></audio>`], ['img', `<img src="http://${a}/${n}-clip-img#t=0,1">`], ['page', `<iframe src="http://${a}/${n}-clip-page#t=0,1"></iframe>`]]) {
    writeFileSync(join(folder, 'film.html'), filmOf(clip));
    await tried(`clip ${kind}`, () => look(['0.5'], {}));
    await tried(`clip ${kind} rendered`, () => render(['0-0.2'], { workers: 1 }));
  }
}
// The preview: the same folder server, in a browser that is not OpenFilm's.
const { chromium } = createRequire(join(pkg, 'src', 'host.mjs'))('playwright-core');
const site = await serve(folder);
const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
for (const path of ['page.html', 'page.html?film-host=0']) {
  await tried('preview', async () => {
    const tab = await browser.newPage();
    await tab.goto(`${site.url}/${path}`, { waitUntil: 'domcontentloaded' });
    await settle(3500);
    console.log(`  preview drew: ${await tab.evaluate(() => { window.film.frame(1); return document.getElementById('d').textContent; }).catch((e) => e.message.split('\n')[0])}`);
    await tab.close();
  });
}
await browser.close();
await site.close();
mode = 'drawing browser alone';
const bareBrowser = await launch();
await tried('drawing browser alone', async () => { const tab = await bareBrowser.newPage(); await tab.goto(`http://${own}:${port}/alone-lan`, { timeout: 4000 }); });
await bareBrowser.close();
for (const name of [...new Set(hits.map((h) => h.mode))]) console.log(`LEAK ${name}: ${hits.filter((h) => h.mode === name).map((h) => h.what).join(' ')}`);
console.log(hits.length ? `${hits.length} ways out` : 'nothing got out');
process.chdir(tmpdir()); // Windows keeps the folder a program is in
try { rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* still in use */ }
process.exit(hits.length ? 1 : 0);
