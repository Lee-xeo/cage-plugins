import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { folderIn } from './helpers.mjs';

const { localize, packageOf, addressesIn, HOSTS } = await import('../lib/localize.mjs');

const sha = (kind, body, as) => createHash(kind).update(body).digest(as);
const GSAP = 'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js';
const MAIN = 'https://cdn.jsdelivr.net/npm/lib@1.2.3/dist/main.mjs';
const UTIL = 'https://cdn.jsdelivr.net/npm/lib@1.2.3/dist/util.mjs';
const THREE = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const JSM = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/';
const ORBIT = `${JSM}controls/OrbitControls.js`;
const CSS = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap';
const FONT_A = 'https://fonts.gstatic.com/s/inter/v1/a.woff2';
const FONT_B = 'https://fonts.gstatic.com/s/inter/v1/b.woff2';

const JS = 'application/javascript; charset=utf-8';
const files = {
  [GSAP]: ['window.gsap = {};', JS],
  [MAIN]: ["import { x } from './util.mjs'; export default x;", JS],
  [UTIL]: ['export const x = 1;', JS],
  [THREE]: ['export const T = 1;', JS],
  [ORBIT]: ['export const O = 2;', JS],
  [CSS]: [`@font-face { font-family: 'Inter'; src: url(${FONT_A}) format('woff2'); }\n@font-face { font-family: 'Inter'; font-weight: 700; src: url(${FONT_B}) format('woff2'); }\n`, 'text/css; charset=utf-8'],
  [FONT_A]: ['woff2 a', 'font/woff2'],
  [FONT_B]: ['woff2 b', 'font/woff2'],
};
const body = (url) => files[url][0];

/** What the publishers say about their files. */
function published(url, wrong = false) {
  const wrongOne = wrong ? 'AAAA' : null;
  if (url.startsWith('https://data.jsdelivr.com/v1/packages/npm/lib@1.2.3')) {
    return { files: [{ name: '/dist/main.mjs', hash: wrongOne ?? sha('sha256', body(MAIN), 'base64') }, { name: '/dist/util.mjs', hash: sha('sha256', body(UTIL), 'base64') }] };
  }
  if (url.startsWith('https://data.jsdelivr.com/v1/packages/npm/three@0.160.0')) {
    return { files: [{ name: '/build/three.module.js', hash: sha('sha256', body(THREE), 'base64') }, { name: '/examples/jsm/controls/OrbitControls.js', hash: sha('sha256', body(ORBIT), 'base64') }] };
  }
  if (url === 'https://api.cdnjs.com/libraries/gsap/3.12.5?fields=sri') return { sri: { 'gsap.min.js': `sha512-${sha('sha512', body(GSAP), 'base64')}` } };
  return null;
}

/** A `get` that answers from the tables above and writes down what it was asked. */
function fake(extra = {}, { wrong = false } = {}) {
  const calls = [];
  const get = async (url, options = {}) => {
    calls.push({ url, options });
    const info = published(url, wrong);
    if (info) return Response.json(info);
    const entry = extra[url] ?? files[url];
    if (!entry) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (entry instanceof Response) return entry;
    return new Response(entry[0], { status: 200, headers: { 'content-type': entry[1], ...(entry[2] ?? {}) } });
  };
  return { get, calls, asked: () => calls.map((call) => call.url) };
}

const FILM = `<!doctype html><html><head>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&amp;display=swap" rel="stylesheet">
<script src="${GSAP}" integrity="sha512-whatever" crossorigin="anonymous"></script>
<script type="module" src="${MAIN}" crossorigin></script>
<script src="/local.js" integrity="sha384-keep" crossorigin="anonymous"></script>
<script src="https://example.com/other.js" integrity="sha384-other" crossorigin></script>
<script src="https://fonts.googleapis.com.evil.example/x.js"></script>
</head><body></body></html>
`;
const PAGE = `<script type="importmap">{"imports":{"three":"${THREE}","three/addons/":"${JSM}"}}</script>
<script type="module">import { OrbitControls } from 'three/addons/controls/OrbitControls.js'; import * as T from 'three';</script>
<link rel="stylesheet" href="${CSS.replace('&', '&amp;')}">
`;

function makeFilm(pages = {}) {
  const folder = folderIn('film');
  writeFileSync(join(folder, 'film.html'), pages['film.html'] ?? FILM);
  for (const [name, text] of Object.entries(pages)) {
    if (name === 'film.html') continue;
    mkdirSync(join(folder, name, '..'), { recursive: true });
    writeFileSync(join(folder, name), text);
  }
  return folder;
}
const read = (folder, name) => readFileSync(join(folder, name), 'utf8');
const list = (dir) => readdirSync(dir, { recursive: true });

test('packageOf', () => {
  assert.deepEqual(packageOf(new URL('https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js')), { name: 'gsap', version: '3.12.5', file: 'dist/gsap.min.js' });
  assert.deepEqual(packageOf(new URL('https://cdn.jsdelivr.net/npm/@scope/pkg@1.2.3-beta.1/dist/x.js')), { name: '@scope/pkg', version: '1.2.3-beta.1', file: 'dist/x.js' });
  assert.deepEqual(packageOf(new URL('https://unpkg.com/@scope/pkg@2.0.0/x.js')), { name: '@scope/pkg', version: '2.0.0', file: 'x.js' });
  assert.deepEqual(packageOf(new URL('https://unpkg.com/gsap@3.12.5/dist/gsap.js')), { name: 'gsap', version: '3.12.5', file: 'dist/gsap.js' });
  assert.equal(packageOf(new URL(GSAP)), null);
  assert.equal(packageOf(new URL(CSS)), null);
  assert.equal(packageOf(new URL(FONT_A)), null);
  for (const bad of ['https://cdn.jsdelivr.net/npm/gsap/dist/x.js', 'https://cdn.jsdelivr.net/npm/gsap@3/dist/x.js', 'https://cdn.jsdelivr.net/npm/gsap@latest/x.js',
    'https://cdn.jsdelivr.net/npm/gsap@3.12/x.js', 'https://cdn.jsdelivr.net/npm/@s/p/x.js', 'https://unpkg.com/react/index.js', 'https://unpkg.com/react@^18.0.0/index.js']) {
    assert.throws(() => packageOf(new URL(bad)), /exact version/, bad);
  }
  assert.throws(() => packageOf(new URL('https://cdn.jsdelivr.net/npm/gsap@3.12.5')), /name a file/);
  assert.throws(() => packageOf(new URL('https://cdn.jsdelivr.net/gh/user/repo@1.0.0/x.js')), /npm packages/);
  assert.throws(() => packageOf(new URL('https://cdn.jsdelivr.net/')), /npm packages/);
});

test('addressesIn finds only the five places, once each', () => {
  assert.deepEqual(HOSTS, ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']);
  const found = addressesIn(`<script src="${GSAP}"></script> url(${FONT_A}) '${GSAP}' https://example.com/a.js http://unpkg.com/x@1.0.0/y.js https://fonts.googleapis.com.evil.example/x`);
  assert.deepEqual(found, [GSAP, FONT_A]);
  assert.deepEqual(addressesIn('nothing'), []);
});

test('a film is localized: fonts, scripts, modules and an import map, pages rewritten', async () => {
  const folder = makeFilm({ 'scenes/a/page.html': PAGE });
  const net = fake();
  const said = [];
  const done = await localize(folder, { get: net.get, say: (line) => said.push(line) });
  assert.deepEqual(done.problems, []);
  assert.equal(done.files, 8);
  assert.equal(done.changed, 2);
  assert.equal(done.checked, 5); // gsap, main, util, three, orbit have a publisher's hash
  assert.ok(said.length > 0);

  const film = read(folder, 'film.html');
  const cssFile = list(join(folder, 'assets/vendor/fonts.googleapis.com')).find((name) => /^css2-[0-9a-f]{8}\.css$/.test(name));
  assert.ok(cssFile, 'the style sheet is kept, its query in its name');
  assert.ok(film.includes(`href="./assets/vendor/fonts.googleapis.com/${cssFile}"`), film);
  assert.ok(film.includes('src="./assets/vendor/cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"'), film);
  assert.ok(film.includes('src="./assets/vendor/cdn.jsdelivr.net/npm/lib@1.2.3/dist/main.mjs"'), film);
  // preconnect is gone, integrity and crossorigin only where the tag was vendored
  assert.ok(!/preconnect/.test(film));
  assert.ok(!/integrity="sha512-whatever"/.test(film));
  assert.match(film, /<script src="\.\/assets\/vendor\/cdnjs\.cloudflare\.com\/ajax\/libs\/gsap\/3\.12\.5\/gsap\.min\.js"><\/script>/);
  assert.match(film, /<script type="module" src="\.\/assets\/vendor\/cdn\.jsdelivr\.net\/npm\/lib@1\.2\.3\/dist\/main\.mjs"><\/script>/);
  assert.ok(film.includes('<script src="/local.js" integrity="sha384-keep" crossorigin="anonymous"></script>'));
  // other hosts are untouched
  assert.ok(film.includes('<script src="https://example.com/other.js" integrity="sha384-other" crossorigin></script>'));
  assert.ok(film.includes('https://fonts.googleapis.com.evil.example/x.js'));
  assert.ok(!net.asked().some((url) => /example\.com|evil/.test(url)));

  // the nested page names the files with relative paths from where it is
  const page = read(folder, 'scenes/a/page.html');
  assert.ok(page.includes('"three":"../../assets/vendor/cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"'), page);
  assert.ok(page.includes('"three/addons/":"../../assets/vendor/cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"'), page);
  assert.ok(page.includes(`href="../../assets/vendor/fonts.googleapis.com/${cssFile}"`), page);
  assert.ok(existsSync(join(folder, 'assets/vendor/cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js')));
  assert.ok(!page.includes('https://'));

  // the style sheet names its fonts beside it, and a module its module
  const css = read(folder, `assets/vendor/fonts.googleapis.com/${cssFile}`);
  assert.ok(css.includes('url(../fonts.gstatic.com/s/inter/v1/a.woff2)') && css.includes('url(../fonts.gstatic.com/s/inter/v1/b.woff2)'), css);
  assert.ok(!css.includes('https://'), css);
  assert.equal(read(folder, 'assets/vendor/fonts.gstatic.com/s/inter/v1/a.woff2'), 'woff2 a');
  assert.equal(read(folder, 'assets/vendor/cdn.jsdelivr.net/npm/lib@1.2.3/dist/main.mjs'), body(MAIN));
  assert.equal(read(folder, 'assets/vendor/cdn.jsdelivr.net/npm/lib@1.2.3/dist/util.mjs'), body(UTIL));

  // what was fetched is recorded with its hash
  const record = JSON.parse(read(folder, 'assets/vendor/vendor.json'));
  assert.deepEqual(Object.keys(record).sort(), Object.keys(files).sort());
  assert.equal(record[GSAP].sha256, sha('sha256', body(GSAP), 'hex'));
  assert.equal(record[GSAP].checked, 'sha512');
  assert.equal(record[MAIN].checked, 'sha256');
  assert.equal(record[FONT_A].checked, 'first fetch');
  assert.equal(record[GSAP].file, 'assets/vendor/cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js');
  assert.equal(record[GSAP].bytes, Buffer.byteLength(body(GSAP)));

  // every request refused a redirect, and fonts were asked for as a browser
  assert.ok(net.calls.length >= 13);
  for (const call of net.calls) assert.equal(call.options.redirect, 'error', call.url);
  assert.match(net.calls.find((call) => call.url === CSS).options.headers['user-agent'], /Chrome/);
  assert.ok(net.calls.every((call) => call.url.startsWith('https://')));
});

test('a second run changes nothing, and vendor.json is merged, not overwritten', async () => {
  const folder = makeFilm({ 'scenes/a/page.html': PAGE });
  await localize(folder, { get: fake().get });
  const before = { film: read(folder, 'film.html'), page: read(folder, 'scenes/a/page.html'), record: read(folder, 'assets/vendor/vendor.json'), tree: list(folder).sort() };
  const net = fake();
  const again = await localize(folder, { get: net.get });
  assert.deepEqual({ files: again.files, changed: again.changed, problems: again.problems }, { files: 0, changed: 0, problems: [] });
  assert.equal(net.calls.length, 0);
  assert.deepEqual({ film: read(folder, 'film.html'), page: read(folder, 'scenes/a/page.html'), record: read(folder, 'assets/vendor/vendor.json'), tree: list(folder).sort() }, before);

  // a new page with a new address: the old records stay, the new one joins them
  const NEW = 'https://unpkg.com/newlib@4.5.6/dist/n.js';
  writeFileSync(join(folder, 'more.html'), `<script src="${NEW}"></script>`);
  const added = await localize(folder, { get: fake({ [NEW]: ['window.n = 1', JS] }).get });
  assert.deepEqual(added.problems, []);
  assert.equal(added.files, 1);
  const record = JSON.parse(read(folder, 'assets/vendor/vendor.json'));
  assert.deepEqual(Object.keys(record).sort(), [...Object.keys(files), NEW].sort());
  assert.equal(record[GSAP].sha256, JSON.parse(before.record)[GSAP].sha256);
  assert.equal(record[NEW].checked, 'first fetch'); // unpkg has no hash of its own to give
  assert.ok(read(folder, 'more.html').includes('./assets/vendor/unpkg.com/newlib@4.5.6/dist/n.js'));
});

test('an address with no exact version is refused and the page is left as it is', async () => {
  const bad = ['https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js', 'https://cdn.jsdelivr.net/npm/gsap/dist/gsap.min.js', 'https://unpkg.com/react/index.js', 'https://cdn.jsdelivr.net/gh/user/repo@1.0.0/x.js'];
  const page = `${bad.map((url) => `<script src="${url}"></script>`).join('\n')}\n`;
  const folder = makeFilm({ 'film.html': page });
  const net = fake();
  const done = await localize(folder, { get: net.get });
  assert.equal(done.problems.length, 4);
  assert.ok(done.problems.some((line) => /exact version/.test(line)));
  assert.ok(done.problems.some((line) => /npm packages/.test(line)));
  assert.ok(done.problems.every((line) => line.startsWith('film.html: ')));
  assert.equal(read(folder, 'film.html'), page);
  assert.equal(net.calls.length, 0);
  assert.ok(!existsSync(join(folder, 'assets', 'vendor', 'vendor.json')));
});

test('a file that does not match its published hash is refused and not kept', async () => {
  const folder = makeFilm({ 'film.html': `<script src="${MAIN}"></script>\n` });
  const done = await localize(folder, { get: fake({}, { wrong: true }).get });
  assert.equal(done.problems.length, 1);
  assert.match(done.problems[0], /published hash/);
  assert.equal(read(folder, 'film.html'), `<script src="${MAIN}"></script>\n`);
  assert.ok(!existsSync(join(folder, 'assets/vendor/cdn.jsdelivr.net/npm/lib@1.2.3/dist/main.mjs')));
  assert.ok(!existsSync(join(folder, 'assets/vendor/vendor.json')));
  // and the cdnjs one
  const other = makeFilm({ 'film.html': `<script src="${GSAP}"></script>\n` });
  const net = fake({ [GSAP]: ['window.gsap = "changed";', JS] });
  const result = await localize(other, { get: async (url, options) => (url === GSAP ? new Response('window.gsap = "changed";', { headers: { 'content-type': JS } }) : net.get(url, options)) });
  assert.match(result.problems[0] ?? '', /published hash/);
});

test('a file that changed since vendor.json recorded it is refused (but a Google style sheet may change)', async () => {
  const folder = makeFilm({ 'film.html': `<script src="${GSAP}"></script>\n<link rel="stylesheet" href="${CSS}">\n` });
  mkdirSync(join(folder, 'assets/vendor'), { recursive: true });
  const old = { sha256: sha('sha256', 'something else', 'hex'), file: 'x', bytes: 1, checked: 'first fetch' };
  writeFileSync(join(folder, 'assets/vendor/vendor.json'), JSON.stringify({ [GSAP]: old, [CSS]: old }));
  const done = await localize(folder, { get: fake().get });
  assert.equal(done.problems.length, 1);
  assert.match(done.problems[0], /not the file it was/);
  assert.ok(done.problems[0].includes(GSAP));
  const page = read(folder, 'film.html');
  assert.ok(page.includes(GSAP), 'the page still names the address');
  assert.ok(!page.includes('https://fonts.googleapis.com'), 'the style sheet was brought in');
  assert.ok(!existsSync(join(folder, 'assets/vendor/cdnjs.cloudflare.com')));
  assert.equal(JSON.parse(read(folder, 'assets/vendor/vendor.json'))[GSAP].sha256, old.sha256, 'the record of the file is not replaced');
});

test('what is not a font, style or script is refused, and so are errors and big files', async () => {
  const URLS = ['https://unpkg.com/a@1.0.0/page.js', 'https://unpkg.com/b@1.0.0/ok.js', 'https://unpkg.com/c@1.0.0/gone.js', 'https://unpkg.com/d@1.0.0/big.js', 'https://unpkg.com/e@1.0.0/none.js', 'https://unpkg.com/f@1.0.0/data.js'];
  const folder = makeFilm({ 'film.html': URLS.map((url) => `<script src="${url}"></script>`).join('\n') });
  const net = fake({
    [URLS[0]]: ['<!doctype html><title>login</title>', 'text/html; charset=utf-8'],
    [URLS[1]]: ['ok()', 'text/javascript'],
    [URLS[2]]: new Response('nope', { status: 404, headers: { 'content-type': JS } }),
    [URLS[3]]: ['x', JS, { 'content-length': '30000000' }],
    [URLS[4]]: new Response(new Uint8Array([1, 2, 3])),
    [URLS[5]]: ['{}', 'application/json'],
  });
  const done = await localize(folder, { get: net.get });
  const problem = (n) => done.problems.find((line) => line.includes(URLS[n]));
  assert.match(problem(0), /not a font, style or script \(text\/html/);
  assert.equal(problem(1), undefined);
  assert.match(problem(2), /HTTP 404/);
  assert.match(problem(3), /over 20 MB/);
  assert.match(problem(4), /not a font, style or script/);
  assert.equal(problem(5), undefined);
  const page = read(folder, 'film.html');
  assert.ok(page.includes('./assets/vendor/unpkg.com/b@1.0.0/ok.js'));
  assert.ok(page.includes(URLS[0]) && page.includes(URLS[3]));
  assert.ok(!existsSync(join(folder, 'assets/vendor/unpkg.com/a@1.0.0')));
});

test('an address is never fetched from another host, a port or with credentials', async () => {
  const folder = makeFilm({ 'film.html': '<script src="https://user:pw@cdn.jsdelivr.net/npm/x@1.0.0/a.js"></script><script src="https://unpkg.com:8443/x@1.0.0/a.js"></script>' });
  const net = fake();
  const done = await localize(folder, { get: net.get });
  assert.equal(net.calls.length, 0);
  assert.ok(done.problems.length <= 2);
});

test('a font is known by its bytes, whatever it is said to be', async () => {
  const kit = 'https://fonts.gstatic.com/l/font?kit=abc&skey=1&v=v20';
  const page = 'https://fonts.gstatic.com/l/font?kit=page';
  const sheet = 'https://fonts.googleapis.com/css2?family=Kit';
  const folder = makeFilm({ 'film.html': `<link href="${sheet}" rel="stylesheet">\n` });
  const done = await localize(folder, { get: fake({ [sheet]: [`@font-face { src: url(${kit}) format('woff2'); }`, 'text/css'], [kit]: ['wOF2....', 'text/html; charset=utf-8'] }).get });
  assert.deepEqual(done.problems, []);
  const vendor = JSON.parse(read(folder, 'assets/vendor/vendor.json'));
  assert.match(vendor[kit].file, /^assets\/vendor\/fonts\.gstatic\.com\/l\/font-[0-9a-f]{8}\.woff2$/);
  assert.ok(read(folder, vendor[sheet].file).includes(vendor[kit].file.split('/').at(-1)));
  const other = makeFilm({ 'film.html': `<link href="${sheet}" rel="stylesheet">\n` });
  const refused = await localize(other, { get: fake({ [sheet]: [`@font-face { src: url(${page}); }`, 'text/css'], [page]: ['<html>', 'text/html'] }).get });
  assert.match(refused.problems.join('\n'), /it loads https:\/\/fonts\.gstatic\.com\/l\/font\?kit=page: not a font/);
});

test('files that load each other are fetched once each, and it ends', async () => {
  const [a, b] = ['https://unpkg.com/cyc@1.0.0/a.js', 'https://unpkg.com/cyc@1.0.0/b.js'];
  const [x, y] = ['https://unpkg.com/cyc@1.0.0/x.css', 'https://unpkg.com/cyc@1.0.0/y.css'];
  const folder = makeFilm({ 'film.html': `<script type="module" src="${a}"></script><link rel="stylesheet" href="${x}">` });
  const net = fake({ [a]: ["import './b.js'", JS], [b]: ["import './a.js'", JS], [x]: ['@import "y.css";', 'text/css'], [y]: ['@import url(x.css);', 'text/css'] });
  const done = await localize(folder, { get: net.get });
  assert.deepEqual(done.problems, []);
  assert.equal(done.files, 4);
  assert.equal(read(folder, 'assets/vendor/unpkg.com/cyc@1.0.0/y.css'), '@import url(./x.css);');
  for (const url of [a, b, x, y]) assert.equal(net.asked().filter((asked) => asked === url).length, 1);
});

test('a symlinked assets/vendor that leaves the film is refused', async (t) => {
  const folder = makeFilm({ 'film.html': `<script src="${GSAP}"></script>\n` });
  const outside = join(folderIn('outside'), 'there');
  mkdirSync(outside);
  mkdirSync(join(folder, 'assets'));
  try { symlinkSync(outside, join(folder, 'assets', 'vendor'), 'junction'); } catch { t.skip('links cannot be made here'); return; }
  const done = await localize(folder, { get: fake().get });
  assert.ok(done.problems.length >= 1);
  assert.match(done.problems.join('\n'), /outside the film/);
  assert.equal(read(folder, 'film.html'), `<script src="${GSAP}"></script>\n`);
  assert.deepEqual(readdirSync(outside, { recursive: true }), [], 'nothing was made outside');
});

test('the folder must hold a film', async () => {
  await assert.rejects(localize(folderIn('empty'), { get: fake().get }), /no film\.html/);
});

test('hidden folders and node_modules are not read', async () => {
  const folder = makeFilm({ 'film.html': '<p>nothing</p>', '.film/x.html': `<script src="${GSAP}"></script>`, 'node_modules/p/index.js': `x = "${GSAP}"` });
  const net = fake();
  const done = await localize(folder, { get: net.get });
  assert.equal(net.calls.length, 0);
  assert.equal(done.changed, 0);
});
