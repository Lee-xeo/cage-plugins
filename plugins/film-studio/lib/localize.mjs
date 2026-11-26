#!/usr/bin/env node
// Bring the web fonts and scripts a film's pages name into the film's folder,
// and make the pages name those instead: node localize.mjs <film folder>
//
// A film's pages are drawn with the network closed, so what they load has to be
// beside them. Pages can be written with addresses of the places below as
// usual; this fetches each into assets/vendor/, follows what it loads in turn
// (a style sheet's fonts, a module's modules), and rewrites the pages. What was
// fetched is recorded in assets/vendor/vendor.json with its SHA-256, and a file
// recorded there must be the same when it is fetched again.
//
// It stands alone (Node 18 or later, no packages), so it can be run from
// wherever the film's folder can be reached.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only places anything is fetched from. */
export const HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'];
const URLS = new RegExp(`https://(?:${HOSTS.map((h) => h.replaceAll('.', '\\.')).join('|')})/[^\\s"'\`)<>\\\\]*`, 'g');
// Google serves woff2 only to a browser that says it reads it.
const AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const KINDS = /^(text\/css|(text|application)\/(x-)?javascript|font\/|application\/(font-|x-font|vnd\.ms-fontobject|wasm|json|octet-stream))/;
const MOST_EACH = 20e6;
const MOST_ALL = 200e6;
const MOST_FILES = 1500;
const AT_ONCE = 12;

const slash = (path) => path.split('\\').join('/');
const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hashOf = (kind, body, as) => createHash(kind).update(body).digest(as);

/** What kind of font a file is by its first bytes; Google says of some of its fonts that they are text/html. */
function fontOf(body) {
  return { '774f4632': 'woff2', '774f4646': 'woff', '4f54544f': 'otf', '00010000': 'ttf', '74727565': 'ttf', '74746366': 'ttc' }[body.toString('hex', 0, 4)] ?? null;
}

/** The integrity a page asks of an address: on a script or link tag that names it, and in an import map's integrity. */
export function integrityOf(text, raw) {
  const wanted = [];
  for (const [tag] of text.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    if (!new RegExp(`=\\s*["']?${quote(raw)}(?=["'\\s>])`).test(tag)) continue;
    const found = tag.match(/\sintegrity\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (found) wanted.push(found[1] ?? found[2] ?? found[3]);
  }
  for (const m of text.matchAll(new RegExp(`["']${quote(raw)}["']\\s*:\\s*["']((?:sha(?:256|384|512)-[^"']*?\\s*)+)["']`, 'g'))) wanted.push(m[1]);
  return wanted;
}

const STRENGTH = ['sha256', 'sha384', 'sha512'];
/**
 * Whether bytes meet an integrity a page asks for, as a browser decides: by
 * the strongest kind of hash it names, any one of those matching. Nothing it
 * can read in it asks for nothing.
 */
export function meets(body, wanted) {
  const named = String(wanted).trim().split(/\s+/).map((token) => token.match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})(?:\?.*)?$/)).filter(Boolean);
  if (!named.length) return true;
  const strongest = named.reduce((best, m) => (STRENGTH.indexOf(m[1]) > STRENGTH.indexOf(best) ? m[1] : best), 'sha256');
  const actual = hashOf(strongest, body, 'base64');
  return named.some((m) => m[1] === strongest && m[2].replaceAll('-', '+').replaceAll('_', '/') === actual);
}

/** The addresses in a text this can fetch. */
export const addressesIn = (text) => [...new Set(text.match(URLS) ?? [])];

/** The package, version and file an npm mirror's address names; a version that is not exact is refused. */
export function packageOf(url) {
  const path = decodeURIComponent(url.pathname);
  const found = url.hostname === 'cdn.jsdelivr.net' ? path.match(/^\/npm\/((?:@[^/]+\/)?[^/@]+)(?:@([^/]+))?(?:\/(.*))?$/)
    : url.hostname === 'unpkg.com' ? path.match(/^\/((?:@[^/]+\/)?[^/@]+)(?:@([^/]+))?(?:\/(.*))?$/) : null;
  if (url.hostname === 'cdn.jsdelivr.net' && !found) throw new Error('only its npm packages can be used (cdn.jsdelivr.net/npm/…)');
  if (url.hostname === 'cdnjs.cloudflare.com') {
    const lib = path.match(/^\/ajax\/libs\/[^/]+\/([^/]+)\/./);
    if (!lib) throw new Error('only its libraries can be used (cdnjs.cloudflare.com/ajax/libs/…)');
    if (!/^\d/.test(lib[1]) || /^latest$/i.test(lib[1])) throw new Error('name an exact version, such as gsap/3.12.5');
  }
  if (!found) return null;
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(found[2] ?? '')) throw new Error('name an exact version, such as gsap@3.12.5');
  if (!found[3]) throw new Error('name a file of the package');
  return { name: found[1], version: found[2], file: found[3] };
}

export async function localize(folder, { say = () => {}, get = fetch } = {}) {
  const root = realpathSync(resolve(folder));
  if (!existsSync(join(root, 'film.html'))) throw new Error(`${folder} has no film.html`);
  const vendor = join(root, 'assets', 'vendor');
  const record = join(vendor, 'vendor.json');
  let lock = {};
  try { lock = JSON.parse(readFileSync(record, 'utf8')); } catch { /* none yet */ }
  const asked = new Map();
  const original = new Map(); // address → the bytes as they came, which an integrity is of
  const bringing = new Set();
  const problems = [];
  let bytes = 0;
  let files = 0;

  /** Nothing is written through a link that leaves the film's folder. */
  function write(path, data) {
    let real = dirname(path);
    while (!existsSync(real)) real = dirname(real);
    const back = relative(root, realpathSync(real));
    if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) throw new Error('its place is outside the film');
    mkdirSync(dirname(path), { recursive: true });
    rmSync(`${path}.part`, { force: true }); // were it a link, it would be written through
    writeFileSync(`${path}.part`, data, { flag: 'wx' });
    renameSync(`${path}.part`, path);
  }

  const from = (page, target) => {
    const path = slash(relative(dirname(page), target)).split('/').map(encodeURIComponent).join('/').replaceAll('%40', '@');
    return path.startsWith('.') ? path : `./${path}`;
  };

  function placeOf(address) {
    const url = new URL(address);
    let path = decodeURIComponent(url.pathname);
    if (url.hostname === 'fonts.googleapis.com') path += '.css';
    const parts = path.split('/').filter(Boolean).map((part) => part.replace(/[:*?"<>|\\\0-\x1f]/g, '_').replace(/^\.+$/, '_').replace(/[. ]+$/, '_'));
    if (url.search) {
      const last = parts.pop();
      const dot = last.lastIndexOf('.');
      parts.push(`${dot > 0 ? last.slice(0, dot) : last}-${hashOf('sha256', url.search, 'hex').slice(0, 8)}${dot > 0 ? last.slice(dot) : ''}`);
    }
    return join(vendor, url.hostname, ...parts);
  }

  /** The hash the publisher gives for a file, when it gives one. */
  async function published(url, pack) {
    try {
      const json = async (address) => (await get(address, { redirect: 'error', signal: AbortSignal.timeout(20000) })).json();
      if (pack) {
        const list = await json(`https://data.jsdelivr.com/v1/packages/npm/${pack.name}@${pack.version}?structure=flat`);
        const hash = list.files?.find((file) => file.name === `/${pack.file}`)?.hash;
        return hash ? ['sha256', hash] : null;
      }
      const lib = url.hostname === 'cdnjs.cloudflare.com' && url.pathname.match(/^\/ajax\/libs\/([^/]+)\/([^/]+)\/(.+)$/);
      if (lib) {
        const sri = (await json(`https://api.cdnjs.com/libraries/${lib[1]}/${lib[2]}?fields=sri`)).sri?.[decodeURIComponent(lib[3])];
        return sri?.startsWith('sha512-') ? ['sha512', sri.slice(7)] : null;
      }
    } catch { /* not told: recorded instead */ }
    return null;
  }

  function fetched(address) {
    if (!asked.has(address)) {
      bringing.add(address);
      asked.set(address, bring(address).finally(() => bringing.delete(address)));
    }
    return asked.get(address);
  }

  /** Refuse an address whose bytes are not what the page's integrity asks of it: the page keeps it, and the browser judges. */
  function checkIntegrity(text, raw, address) {
    for (const wanted of integrityOf(text, raw)) {
      if (!meets(original.get(address) ?? Buffer.alloc(0), wanted)) throw new Error(`is not what the page's integrity asks for (${wanted.trim().split(/\s+/)[0].slice(0, 24)}…); the page was left as it is`);
    }
  }

  /** What a fetched file loads in turn. One still being brought loads this one too: it is not waited for. */
  async function within(text, loader) {
    const address = new URL(text, loader).href.split('#')[0];
    if (bringing.has(address)) return placeOf(address);
    try { return await fetched(address); } catch (error) { throw new Error(/ loads /.test(error.message) ? error.message : `it loads ${address}: ${error.message}`); }
  }

  async function bring(address) {
    const url = new URL(address);
    if (url.protocol !== 'https:' || !HOSTS.includes(url.hostname) || url.port || url.username) throw new Error('not one of the places this fetches from');
    const pack = packageOf(url);
    if ((files += 1) > MOST_FILES) throw new Error('too many files for one film');
    const answer = await get(address, { headers: { 'user-agent': AGENT }, redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
    const kind = answer.headers.get('content-type') ?? '';
    if (Number(answer.headers.get('content-length')) > MOST_EACH) throw new Error('over 20 MB');
    let body = Buffer.from(await answer.arrayBuffer());
    if (body.length > MOST_EACH) throw new Error('over 20 MB');
    if ((bytes += body.length) > MOST_ALL) throw new Error('over 200 MB for one film');
    const font = fontOf(body);
    if (!font && !KINDS.test(kind)) throw new Error(`not a font, style or script (${kind || 'it does not say what it is'})`);
    original.set(address, body);
    const sha256 = hashOf('sha256', body, 'hex');
    const google = url.hostname === 'fonts.googleapis.com'; // its style sheets change as fonts are added to
    if (!google && lock[address] && lock[address].sha256 !== sha256) throw new Error('is not the file it was when it was first fetched; it was not used');
    const given = await published(url, pack);
    if (given && hashOf(given[0], body, 'base64') !== given[1]) throw new Error('does not match its published hash; it was not used');
    const place = placeOf(address) + (font && !/\.[a-z0-9]+$/i.test(url.pathname) ? `.${font}` : '');
    if (/css/.test(kind) && !font) {
      let css = body.toString();
      const loads = [...css.matchAll(/(@import\s+)?(?:url\(\s*["']?([^"')]+?)["']?\s*\)|(?<=@import\s+)["']([^"']+)["'])/g)]
        .map((m) => ({ text: m[2] ?? m[3], style: Boolean(m[1]) || m[3] !== undefined })).filter(({ text }) => !/^(data:|#)/.test(text));
      const places = new Map();
      for (const { text } of loads.filter((load) => load.style)) places.set(text, await within(text, address));
      const others = [...new Set(loads.map((load) => load.text))].filter((text) => !places.has(text));
      for (let i = 0; i < others.length; i += AT_ONCE) {
        await Promise.all(others.slice(i, i + AT_ONCE).map(async (text) => places.set(text, await within(text, address))));
      }
      for (const text of [...places.keys()].sort((a, b) => b.length - a.length)) css = css.split(text).join(from(place, places.get(text)));
      body = Buffer.from(css);
    } else if (/javascript/.test(kind) && !font) {
      for (const m of body.toString().matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) await within(m[1], address);
    }
    write(place, body);
    lock[address] = { file: slash(relative(root, place)), sha256, bytes: Number(answer.headers.get('content-length')) || body.length, checked: given ? given[0] : 'first fetch' };
    return place;
  }

  function* pages(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || join(dir, entry.name) === vendor) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* pages(path);
      else if (entry.isFile() && /\.(html?|css|m?js)$/i.test(entry.name)) yield path;
    }
  }

  let changed = 0;
  for (const page of pages(root)) {
    const before = readFileSync(page, 'utf8');
    let text = before;
    const html = /\.html?$/i.test(page);
    for (const raw of addressesIn(text).sort((a, b) => b.length - a.length)) {
      const address = raw.replaceAll('&amp;', '&');
      try {
        if (address.endsWith('/')) {
          // a folder in an import map: the modules the page takes from it
          const key = text.match(new RegExp(`["']([^"'\\s]+/)["']\\s*:\\s*["']${quote(raw)}["']`))?.[1];
          if (!key) continue; // a preconnect, or words
          for (const m of text.matchAll(new RegExp(`["']${quote(key)}([^"']+)["']`, 'g'))) {
            await fetched(address + m[1]);
            checkIntegrity(text, raw + m[1], address + m[1]);
          }
          const there = join(vendor, new URL(address).hostname, ...decodeURIComponent(new URL(address).pathname).split('/').filter(Boolean));
          text = text.replace(new RegExp(`(["'])${quote(raw)}\\1`, 'g'), (_all, q) => `${q}${from(page, there)}/${q}`);
        } else {
          say(`fetching ${address}`);
          const place = await fetched(address);
          checkIntegrity(text, raw, address);
          const local = from(page, place);
          text = text.replace(new RegExp(`${quote(raw)}(?=[\\s"'\`)<>\\\\]|$)`, 'g'), () => local);
        }
      } catch (error) {
        problems.push(`${slash(relative(root, page))}: ${address}: ${error.message}`);
      }
    }
    if (html && text !== before) {
      // what a local file has no use for, or is refused for
      text = text.replace(/<link\b[^>]*\brel\s*=\s*["']?(?:preconnect|dns-prefetch)\b[^>]*>[ \t]*\r?\n?/gi, '');
      text = text.replace(/<(?:script|link)\b[^>]*assets\/vendor\/[^>]*>/gi, (tag) => tag.replace(/\s+(?:integrity|crossorigin)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, ''));
    }
    if (text !== before) { write(page, text); changed += 1; }
  }
  const got = [...asked.keys()].filter((address) => lock[address]);
  if (got.length) write(record, `${JSON.stringify(Object.fromEntries(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b))), null, 1)}\n`);
  return { files: got.length, bytes, changed, checked: got.filter((a) => lock[a].checked !== 'first fetch').length, problems };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (!process.argv[2]) { console.error('usage: localize.mjs <film folder>'); process.exit(2); }
  try {
    const done = await localize(process.argv[2], { say: (line) => console.log(line) });
    console.log(`${done.files} files (${(done.bytes / 1e6).toFixed(1)} MB), ${done.checked} checked against the publisher's hash; ${done.changed} pages changed`);
    for (const problem of done.problems) console.log(`✗ ${problem}`);
    process.exit(done.problems.length ? 1 : 0);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
