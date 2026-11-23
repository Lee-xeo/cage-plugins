import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { folderIn } from './helpers.mjs';

const { Project, Refused } = await import('../lib/paths.mjs');
const { renderArgs, lookArgs, commandArgs, parseOpen, COMMANDS } = await import('../lib/openfilm.mjs');

const base = folderIn('of');
const root = join(base, 'p');
const folder = join(root, 'film');
mkdirSync(folder, { recursive: true });
const project = new Project(root);
const ctx = { project, folder };

test('renderArgs: nothing, and every option', () => {
  assert.deepEqual(renderArgs({}, ctx), ['render']);
  assert.deepEqual(renderArgs({ range: ' 3-6.5 ', fps: 30, uhd: true, scale: 2, blur: true, alpha: true, subtitles: true, loudness: -14, workers: 4, out: 'x.mp4' }, ctx),
    ['render', '3-6.5', '--fps', '30', '--4k', '--scale', '2', '--blur', '--alpha', '--subtitles', '--loudness=-14', '--workers', '4', '--out', join(folder, 'x.mp4')]);
  assert.deepEqual(renderArgs({ uhd: false, blur: false, range: '', out: ' ' }, ctx), ['render']);
});

test('renderArgs: bounds and shapes', () => {
  for (const bad of [{ range: '3' }, { range: '3-' }, { range: '-3' }, { range: 'a-b' }, { range: '1-2 --out /x' }, { range: '1-2-3' },
    { fps: 0 }, { fps: 241 }, { fps: 'x' }, { scale: 0.05 }, { scale: 9 }, { workers: 0 }, { workers: 65 }, { workers: 1.5 },
    { loudness: -4 }, { loudness: -71 }, { loudness: 'loud' }, { loudness: '-14 --out /etc/x' }, { loudness: true }, { loudness: NaN }]) {
    assert.throws(() => renderArgs(bad, ctx), Refused, JSON.stringify(bad));
  }
  assert.deepEqual(renderArgs({ fps: 1, scale: 0.1, workers: 64, loudness: -70 }, ctx).slice(1),
    ['--fps', '1', '--scale', '0.1', '--loudness=-70', '--workers', '64']);
  assert.deepEqual(renderArgs({ fps: null, scale: undefined }, ctx), ['render']);
});

test('renderArgs: out is a video inside the project', () => {
  assert.deepEqual(renderArgs({ out: 'sub/a.WEBM' }, ctx), ['render', '--out', join(folder, 'sub', 'a.WEBM')]);
  assert.deepEqual(renderArgs({ out: join(root, 'o.mov') }, ctx), ['render', '--out', join(root, 'o.mov')]);
  for (const out of ['x.txt', 'x', 'x.mp4.sh', 'x.mp4 ', '../../x.mp4', join(base, 'x.mp4'), '/etc/x.mp4', '~/x.mp4', '//h/x.mp4', '.film/../../../x.mp4']) {
    if (out === 'x.mp4 ') continue; // trimmed: a plain video name
    assert.throws(() => renderArgs({ out }, ctx), Refused, out);
  }
});

test('lookArgs', () => {
  assert.deepEqual(lookArgs({}, ctx), ['look']);
  assert.deepEqual(lookArgs({ what: '4.5' }, ctx), ['look', '4.5']);
  assert.deepEqual(lookArgs({ what: '3-6' }, ctx), ['look', '3-6']);
  assert.deepEqual(lookArgs({ what: 'clip.mp4' }, ctx), ['look', join(folder, 'clip.mp4')]);
  assert.deepEqual(lookArgs({ at: ['1', 2, '3-4.5'], count: 9, full: true, loudness: -16 }, ctx), ['look', '1', '2', '3-4.5', '--count', '9', '--full', '--loudness=-16']);
  assert.deepEqual(lookArgs({ at: 'x' }, ctx), ['look']);
  for (const bad of [{ what: '../../etc/passwd' }, { what: '/etc/passwd' }, { what: join(base, 'x') }, { what: '~/x' }, { at: ['x'] }, { at: ['--full'] }, { at: ['1; ls'] },
    { count: 0 }, { count: 201 }, { count: 1.5 }, { loudness: 0 }, { loudness: 'x' }]) {
    assert.throws(() => lookArgs(bad, ctx), Refused, JSON.stringify(bad));
  }
});

const run = (args, folderToo = folder) => commandArgs(args, { project, folder: folderToo });
const refuses = (args, pattern, folderToo = folder) => assert.throws(() => run(args, folderToo), pattern ? (e) => e instanceof Refused && pattern.test(e.message) : Refused, JSON.stringify(args));

test('commandArgs allows every allowed command', () => {
  assert.deepEqual(run(['doctor'], null), ['doctor']);
  assert.deepEqual(run(['skills'], null), ['skills']);
  assert.deepEqual(run(['skill', 'film'], null), ['skill', 'film']);
  assert.deepEqual(run(['skill', 'a-b_c.d'], null), ['skill', 'a-b_c.d']);
  for (const verb of COMMANDS.get) assert.deepEqual(run(['get', verb, '--prompt', 'a cat']), ['get', verb, '--prompt', 'a cat'], verb);
  for (const verb of COMMANDS.edit) assert.deepEqual(run(['edit', verb, 'x']), ['edit', verb, 'x'], verb);
  for (const verb of COMMANDS.color) assert.deepEqual(run(['color', verb]), ['color', verb], verb);
  assert.deepEqual(run(['canvas']), ['canvas']);
  assert.deepEqual(run(['canvas', 'apply', 'x']), ['canvas', 'apply', 'x']);
  assert.deepEqual(run(['canvas', 'add']), ['canvas', 'add']);
});

test('commandArgs: paths inside the film or project become this computer\'s', () => {
  // a relative path inside the film is checked and kept: the program runs in the film's folder
  assert.deepEqual(run(['get', 'image', '--out', 'sub/x.png']), ['get', 'image', '--out', 'sub/x.png']);
  assert.deepEqual(run(['get', 'image', '--ref=sub/a.png']), ['get', 'image', '--ref=sub/a.png']);
  assert.deepEqual(run(['get', 'image', `--ref=${root}/sub/../a.png`]), ['get', 'image', `--ref=${join(root, 'a.png')}`]);
  assert.deepEqual(run(['edit', 'add', join(root, 'other', 'a.png')]), ['edit', 'add', join(root, 'other', 'a.png')]);
  assert.deepEqual(run(['edit', 'add', './a.png', 'b']), ['edit', 'add', './a.png', 'b']);
  assert.deepEqual(run(['get', 'image', '--ref', 'a.png']), ['get', 'image', '--ref', 'a.png']);
});

test('commandArgs refuses commands that are not allowed', () => {
  refuses(['open'], /film_open/, null);
  refuses(['look'], /film_look/, null);
  refuses(['render'], /film_render/, null);
  refuses(['update'], /kept at/, null);
  refuses(['publish'], /cannot be run/, null);
  refuses(['publish', 'x'], /cannot be run/);
  refuses(['nonsense'], /cannot be run/);
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) refuses([name], null, null);
  assert.throws(() => commandArgs(['constructor'], { project: null, folder: null }), /cannot be run here/);
  refuses(['skill', 'add'], null, null);
  refuses(['skill', 'remove'], null, null);
  refuses(['skill', 'add', 'https://x.com/s'], null, null);
  refuses(['skill', 'a', 'b'], null, null);
  refuses(['skill'], null, null);
  refuses(['skill', '../x'], null, null);
  refuses(['skill', '..'], null, null);
  refuses(['skill', '/etc/passwd'], null, null);
  refuses(['skill', '-x'], null, null);
  refuses(['skill', ' x'], null, null);
  refuses(['skill', 'a;b'], null, null);
  refuses(['skill', 'a\nb'], null, null);
  refuses(['skills', 'x'], /takes nothing/, null);
  refuses(['doctor', '--fix'], /takes nothing/, null);
  refuses(['get', 'web-fetch', 'https://x.com'], /cannot be run/);
  refuses(['get', 'web-fetch'], /cannot be run/);
  refuses(['get', 'web-search', '--query', 'x'], /cannot be run/);
  refuses(['get', 'call', 'x'], /cannot be run/);
  refuses(['get'], /cannot be run/);
  refuses(['edit', 'publish'], /cannot be run/);
  refuses(['edit'], /cannot be run/);
  refuses(['canvas', 'delete'], /cannot be run/);
  refuses(['color', 'x'], /cannot be run/);
});

test('commandArgs refuses bad words in args', () => {
  for (const args of [[], 'doctor', null, undefined, [5], ['doctor', null], ['get', 'image', {}], ['doctor\0']]) {
    assert.throws(() => commandArgs(args, { project, folder }), Refused, JSON.stringify(args));
  }
});

test('commandArgs refuses addresses, @files and paths outside', () => {
  refuses(['get', 'image', 'https://example.com/a.png']);
  refuses(['get', 'image', 'http://example.com/a.png']);
  refuses(['get', 'image', 'file:///etc/passwd']);
  refuses(['get', 'image', 'ftp://x/y']);
  refuses(['get', 'image', '--ref=https://example.com/a.png']);
  refuses(['get', 'image', '--ref', 'https://example.com/a.png']);
  refuses(['get', 'image', '@/etc/passwd']);
  refuses(['get', 'image', '@file']);
  refuses(['get', 'image', '--ref=@file']);
  refuses(['edit', 'add', '/etc/passwd']);
  refuses(['edit', 'add', join(base, 'elsewhere', 'x.png')]);
  refuses(['edit', 'add', '../../x']);
  refuses(['edit', 'add', '../../../etc/passwd']);
  refuses(['edit', 'add', 'sub/../../../x']);
  refuses(['edit', 'add', '~/x']);
  refuses(['edit', 'add', '~']);
  if (process.platform === 'win32') refuses(['edit', 'add', 'C:\\Windows\\x']);
  refuses(['edit', 'add', '\\\\host\\share\\x']);
  refuses(['edit', 'add', '//host/share/x']);
  refuses(['get', 'image', '--ref=/etc/passwd']);
  refuses(['get', 'image', '--ref', '/etc/passwd']);
  refuses(['get', 'image', '--ref=../../../x']);
  refuses(['get', 'image', '--out=~/x.png']);
  refuses(['get', 'image', '--REF=/etc/passwd']);
});

test('commandArgs leaves the words of --prompt and the like alone, slashes and all', () => {
  const words = '/etc/passwd and https://example.com/x and ../../y @file C:\\x';
  for (const option of ['--prompt', '--text', '--lyrics', '--voice', '--style', '--negative', '--title', '--query']) {
    assert.deepEqual(run(['get', 'image', option, words]), ['get', 'image', option, words], option);
    assert.deepEqual(run(['get', 'image', `${option}=${words}`]), ['get', 'image', `${option}=${words}`], option);
  }
  assert.deepEqual(run(['get', 'tts', '--text', 'a/b', '--out', 'v.mp3']), ['get', 'tts', '--text', 'a/b', '--out', 'v.mp3']);
  // the words are the option's value only: what follows is checked again
  refuses(['get', 'tts', '--text', 'hi', '/etc/passwd']);
  // an option left without its value
  assert.deepEqual(run(['get', 'tts', '--text']), ['get', 'tts', '--text']);
  // an option right after it is not its words: it is checked as itself
  refuses(['get', 'image', '--prompt', '--src=/etc/passwd']);
  refuses(['get', 'image', '--prompt', '--ref', '/etc/passwd']);
  assert.deepEqual(run(['get', 'image', '--prompt', '--out=a.png']), ['get', 'image', '--prompt', '--out=a.png']);
  // only get's options are words: elsewhere their value is checked like any other
  refuses(['edit', 'add', '--title', '/etc/passwd']);
  refuses(['color', 'look', '--text=/etc/passwd']);
});

test('commandArgs: canvas apply with steps as JSON checks the paths in them', () => {
  const steps = [{ op: 'add', kind: 'file', id: 'a', path: 'assets/shot.png' }, { op: 'add', kind: 'note', id: 'n', text: 'see C:\\x and /etc/passwd: "quoted"' }];
  assert.deepEqual(JSON.parse(run(['canvas', 'apply', JSON.stringify(steps)])[2]), steps);
  const inside = run(['canvas', 'apply', JSON.stringify({ op: 'version', id: 'a', path: join(folder, 'assets', 'v2.png') })]);
  assert.equal(JSON.parse(inside[2]).path, join(folder, 'assets', 'v2.png'));
  for (const path of ['/etc/passwd', '../../../x.png', 'https://example.com/x.png', '@x']) {
    refuses(['canvas', 'apply', JSON.stringify([{ op: 'add', kind: 'file', path }])]);
    refuses(['canvas', 'apply', JSON.stringify([{ op: 'set', id: 'a', deep: { path } }])]);
  }
  refuses(['canvas', 'apply', '[not json'], /not JSON/);
  // a .json file of the project is still a path
  assert.deepEqual(run(['canvas', 'apply', 'steps.json']), ['canvas', 'apply', 'steps.json']);
  refuses(['canvas', 'apply', '/etc/steps.json']);
});

test('commandArgs: folder is required for get and edit', () => {
  for (const args of [['get', 'image'], ['edit', 'add'], ['edit', 'look'], ['canvas'], ['color', 'look']]) refuses(args, /folder is required/, null);
});

test('commandArgs: /d/... paths are this computer\'s only on Windows', { skip: process.platform !== 'win32' }, () => {
  // on Windows the project D:\x is /d/x to the caller
  const drive = project.root[0].toLowerCase();
  const asCaller = `/${drive}${project.root.slice(2).replaceAll('\\', '/')}/film/a.png`;
  assert.deepEqual(run(['edit', 'add', asCaller]), ['edit', 'add', join(folder, 'a.png')]);
  refuses(['edit', 'add', `/${drive}/definitely-not-the-project/x`]);
});

test('commandArgs: on other systems /d/... is just an absolute path', { skip: process.platform === 'win32' }, () => {
  refuses(['edit', 'add', '/d/Cage/x.png']);
  assert.deepEqual(run(['edit', 'add', join(folder, 'd', 'x.png')]), ['edit', 'add', join(folder, 'd', 'x.png')]);
});

test('parseOpen: posix and Windows paths, only 127.0.0.1 addresses', () => {
  const said = '\x1b[1mproject\x1b[0m\nproject  /home/a/My Films/p\nStudio   http://127.0.0.1:41234/?k=abc-1\n';
  assert.deepEqual(parseOpen(said.replace('\x1b[1m', '').replace('\x1b[0m', '')), { project: '/home/a/My Films/p', url: 'http://127.0.0.1:41234/?k=abc-1', alreadyOpen: false });
  assert.deepEqual(parseOpen('project D:\\Films\\open film－cage\\p  \nStudio http://127.0.0.1:5/\n  already open in a browser\n'),
    { project: 'D:\\Films\\open film－cage\\p', url: 'http://127.0.0.1:5/', alreadyOpen: true });
  assert.equal(parseOpen('project C:/x/y\n').project, 'C:/x/y');
  assert.equal(parseOpen('project relative/x\n').project, null);
  for (const url of ['http://localhost:4000/', 'https://127.0.0.1:4000/', 'http://127.0.0.1.evil.com:80/', 'http://evil.com:80/ http://127.0.0.1:80/', 'http://10.0.0.1:80/', 'http://127.0.0.1/', 'http://[::1]:80/']) {
    assert.equal(parseOpen(`Studio ${url}\n`).url, null, url);
  }
  assert.equal(parseOpen('see Studio http://127.0.0.1:80/\n').url, null);
  assert.deepEqual(parseOpen(''), { project: null, url: null, alreadyOpen: false });
});
