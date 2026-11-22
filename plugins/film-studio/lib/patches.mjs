// What this plugin changes in the OpenFilm it installs, so that the pages of a
// film, which are programs, cannot reach the network from this computer: not
// while they are drawn (look, render, exports, thumbnails), and not in the
// editor's preview, which plays in the person's own browser.
//
// Each change replaces one text that must be in the file exactly once. The
// version is locked, so a text that is not there means it is not the OpenFilm
// this was written for, and the install is refused rather than left open.
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from './refused.mjs';

/** What a film's page may load: its own folder, and what it makes itself. */
export const POLICY = [
  "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self' data: blob:", "frame-src 'self' data: blob:", "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  // no windows of its own, no forms, no taking over the window it is shown in
  'sandbox allow-scripts allow-same-origin',
].join('; ');

/** WebRTC, which no page policy covers, is taken from the page before its own scripts run. */
const NO_RTC = "for(const k of['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCIceTransport'])"
  + "try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch{}";

/** The drawing browser finds no address but this computer's own (OpenFilm's server), and opens no direct UDP. */
const FLAGS = ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--dns-prefetch-disable'];

export const PATCHES = [
  {
    file: 'src/host.mjs', why: 'pages are drawn with everything outside their own folder refused, and said so',
    find: 'transparent = false, black = false, offline = false, network = {}',
    put: 'transparent = false, black = false, offline = true, network = {}',
  },
  {
    file: 'src/host.mjs', why: 'the drawing browser has no way out even where a page gets past that (WebSocket, WebRTC)',
    find: "'--enable-blink-features=CanvasDrawElement', ...extra];",
    put: `'--enable-blink-features=CanvasDrawElement', ${FLAGS.map((flag) => JSON.stringify(flag)).join(', ')}, ...extra];`,
  },
  {
    file: 'src/host.mjs', why: "the editor's preview, in the person's browser, is told the same by the page's own policy",
    find: 'headers: extraHeaders = {}, swap, missed, grade, timeline, renderRanges } = {}) {\n  root = resolve(root);',
    put: 'headers: givenHeaders = {}, swap, missed, grade, timeline, renderRanges } = {}) {\n'
      + `  const extraHeaders = { ...givenHeaders, 'content-security-policy': ${JSON.stringify(POLICY)}, 'x-dns-prefetch-control': 'off' };\n`
      + '  root = resolve(root);\n'
      + `  inject = \`<script>${NO_RTC}</script>\${inject}\`;\n`
      + `  timelineInject = \`<script>${NO_RTC}</script>\${timelineInject}\`;\n`,
  },
  {
    file: 'src/host.mjs', why: 'the same for a page asked for as a visitor would see it: read here too, not sent as a plain file',
    find: "if (type.startsWith('text/html') && (revision || query?.get('film-host') !== '0')) {",
    put: "if (type.startsWith('text/html')) {",
  },
  {
    file: 'src/host.mjs', why: "film.html's own text is only read (by the timeline that plays it): it runs nothing",
    find: "if (query?.get('film-host') === '0') { res.writeHead(200, headers).end(html); return true; }",
    put: "if (query?.get('film-host') === '0') { res.writeHead(200, film ? { ...headers, 'content-security-policy': \"default-src 'none'; sandbox\" } : headers)"
      + `.end(film ? html : injectFirst(html, ${JSON.stringify(`<script>${NO_RTC}</script>`)})); return true; }`,
  },
];

/** Names this set of changes: an OpenFilm installed with another set is installed again. */
export const PATCHES_DIGEST = createHash('sha256').update(JSON.stringify(PATCHES)).digest('hex').slice(0, 8);

/** Make the changes in an OpenFilm package's folder; all of them or none. */
export function applyPatches(folder) {
  const texts = new Map();
  for (const { file, find, put } of PATCHES) {
    const text = texts.get(file) ?? readFileSync(join(folder, file), 'utf8').replace(/\r\n/g, '\n');
    if (text.split(find).length !== 2) throw new Refused(`this OpenFilm is not the one the plugin was made for (${file}); it was not used`);
    texts.set(file, text.replace(find, () => put));
  }
  for (const [file, text] of texts) {
    const at = join(folder, file);
    writeFileSync(`${at}.patched`, text);
    renameSync(`${at}.patched`, at);
  }
}
