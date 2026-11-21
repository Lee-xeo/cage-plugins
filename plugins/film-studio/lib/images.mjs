// The pictures `openfilm look` wrote, as images in a tool's answer: at most a few,
// each a JPEG no larger than 1568 px on its long edge (contact sheets are PNGs
// of several megabytes; a model sees no more detail than that).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE } from './paths.mjs';

const PICTURE = /\.(jpe?g|png|webp)$/i;
const AS_IS = 1_000_000;

/** Image contents for up to `most` of `paths`; the rest are left for the text to name. */
export function images(paths, most = 4) {
  const contents = [];
  for (const path of paths.filter((item) => PICTURE.test(item) && existsSync(item)).slice(0, most)) {
    const size = statSync(path).size;
    if (/\.jpe?g$/i.test(path) && size <= AS_IS) {
      contents.push({ type: 'image', data: readFileSync(path).toString('base64'), mimeType: 'image/jpeg' });
      continue;
    }
    const key = createHash('sha1').update(`${path}\n${statSync(path).mtimeMs}`).digest('hex');
    const target = join(CACHE, 'look', `${key}.jpg`);
    if (!existsSync(target)) {
      mkdirSync(join(CACHE, 'look'), { recursive: true });
      const fit = "scale='if(gt(iw,ih),min(1568,iw),-2)':'if(gt(iw,ih),-2,min(1568,ih))'";
      spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', path, '-vf', fit, '-frames:v', '1', '-q:v', '3', target], { timeout: 30000 });
    }
    if (existsSync(target)) contents.push({ type: 'image', data: readFileSync(target).toString('base64'), mimeType: 'image/jpeg' });
    else if (size <= AS_IS * 4) {
      contents.push({ type: 'image', data: readFileSync(path).toString('base64'), mimeType: /\.png$/i.test(path) ? 'image/png' : 'image/webp' });
    }
  }
  return contents;
}
