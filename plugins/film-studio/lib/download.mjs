// A download whose size and SHA-256 were recorded beforehand (runtime/browser.json):
// the file is kept only when both match, so nothing fetched here is run unless it
// is exactly the file that was checked when the plugin was made.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Refused } from './paths.mjs';

/** A download that brings nothing for this long has stalled: it is stopped and tried again. */
const STALL_MS = 30_000;
const TRIES = 3;

const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Whether `file` is already the pinned file. */
export function matches(file, { size, sha256 }) {
  return existsSync(file) && statSync(file).size === size && sha256Of(file) === sha256;
}

/**
 * Fetch the file to `dest`, trying each address in turn, up to TRIES rounds.
 * `say` gets a line now and then ("progress 12.3/98.4 MB").
 * @param {{ urls: string[], size: number, sha256: string }} pin
 */
export async function fetchPinned(pin, dest, say = () => {}) {
  if (!Array.isArray(pin.urls) || !pin.urls.length || !Number.isInteger(pin.size) || !/^[0-9a-f]{64}$/.test(pin.sha256)) {
    throw new Refused('the pinned download has no address, size or SHA-256');
  }
  if (matches(dest, pin)) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let last = null;
  for (let round = 0; round < TRIES; round++) {
    for (const url of pin.urls) {
      if (!url.startsWith('https://')) continue;
      try {
        await fetchOnce(url, part, pin, say);
        renameSync(part, dest);
        return dest;
      } catch (error) {
        rmSync(part, { force: true });
        if (error instanceof Refused) throw error;
        last = error;
        say(`${new URL(url).host}: ${error.message}`);
      }
    }
    await new Promise((done) => setTimeout(done, 1000 + round * 2000));
  }
  throw new Refused(`the download failed (${last?.message ?? 'no address answered'}); check the network connection and try again`);
}

async function fetchOnce(url, part, { size, sha256 }, say) {
  const abort = new AbortController();
  let stall = setTimeout(() => abort.abort(new Error('stalled')), STALL_MS);
  const bump = () => { clearTimeout(stall); stall = setTimeout(() => abort.abort(new Error('stalled')), STALL_MS); };
  try {
    const response = await fetch(url, { signal: abort.signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const hash = createHash('sha256');
    const out = createWriteStream(part);
    let got = 0;
    let told = -1;
    const mb = (bytes) => (bytes / 1e6).toFixed(1);
    for await (const chunk of response.body) {
      bump();
      got += chunk.length;
      if (got > size) throw new Refused('the download is larger than the file that was checked; it was not used');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((done) => out.once('drain', done));
      const step = Math.floor((got / size) * 50);
      if (step !== told) { told = step; say(`progress ${mb(got)}/${mb(size)} MB`); }
    }
    await new Promise((done, fail) => out.end((error) => (error ? fail(error) : done())));
    if (got !== size || hash.digest('hex') !== sha256) {
      throw new Refused('the download did not match its recorded SHA-256; it was not used');
    }
  } finally {
    clearTimeout(stall);
  }
}
