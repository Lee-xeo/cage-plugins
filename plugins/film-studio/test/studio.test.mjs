import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { folderIn } from './helpers.mjs';

const { changed, openBrowser, giveLocalize, localizeIn, films, studio, noteOpened, lastOpened } = await import('../lib/studio.mjs');
const { Project, Refused, OPENFILM_HOME, PLUGIN } = await import('../lib/paths.mjs');

/** A stand-in for spawn that writes down what it was asked and answers as told. */
function starter(how = 'spawn') {
  const seen = [];
  const start = (program, args, options) => {
    seen.push({ program, args, options });
    const child = new EventEmitter();
    child.unref = () => { child.unreffed = true; };
    setImmediate(() => child.emit(how, new Error('no such program')));
    return child;
  };
  return { start, seen };
}

test('openBrowser shows only addresses of the editor', async () => {
  const { start, seen } = starter();
  for (const url of ['http://example.com/', 'https://127.0.0.1:4000/', 'http://127.0.0.1.evil.example:80/', 'http://localhost:4000/', 'http://127.0.0.1/', 'http://127.0.0.1:4000',
    'http://127.0.0.1:4000/ x', 'http://127.0.0.1:4000/;calc', 'http://127.0.0.1:4000/\nx', 'http://127.0.0.1:4000/"', 'file:///etc/passwd', 'calc.exe', '', 'http://127.0.0.1:1/', 'http://127.0.0.1:123456/',
    'http://user@127.0.0.1:4000/', 'http://127.0.0.1:4000/`x`', "http://127.0.0.1:4000/'x", 'http://127.0.0.1:4000/<x>', 'http://127.0.0.1:4000/$(x)']) {
    assert.throws(() => openBrowser(url, { platform: 'linux', start }), Refused, JSON.stringify(url));
  }
  assert.throws(() => openBrowser(undefined, { start }), Refused);
  assert.equal(seen.length, 0, 'nothing was started');
});

test('openBrowser picks the program of each system', async () => {
  const url = 'http://127.0.0.1:4173/studio?key=abc-1_2.3~%20&x=y+z';
  for (const [platform, program, args] of [
    ['linux', 'xdg-open', [url]],
    ['freebsd', 'xdg-open', [url]],
    ['darwin', '/usr/bin/open', [url]],
    ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler', url]],
  ]) {
    const { start, seen } = starter();
    assert.equal(await openBrowser(url, { platform, start }), true, platform);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].program, program, platform);
    assert.deepEqual(seen[0].args, args, platform);
    assert.equal(seen[0].options.detached, true);
    assert.equal(seen[0].options.stdio, 'ignore');
  }
});

test('openBrowser says false when the program cannot start', async () => {
  const { start } = starter('error');
  assert.equal(await openBrowser('http://127.0.0.1:4173/', { platform: 'linux', start }), false);
});

test('giveLocalize copies lib/localize.mjs into a film, and only when it is a film', () => {
  const root = folderIn('studio');
  const project = new Project(root);
  const film = join(root, 'f');
  mkdirSync(film);
  giveLocalize(film, project);
  assert.throws(() => statSync(localizeIn(film)), 'no film.html, no copy');
  writeFileSync(join(film, 'film.html'), '<p>');
  giveLocalize(film, project);
  const source = readFileSync(join(PLUGIN, 'lib', 'localize.mjs'), 'utf8');
  assert.equal(localizeIn(film), join(film, '.film', 'film-studio', 'localize.mjs'));
  assert.equal(readFileSync(localizeIn(film), 'utf8'), source);
  // up to date: not written again
  utimesSync(localizeIn(film), 1000, 1000);
  giveLocalize(film, project);
  assert.equal(statSync(localizeIn(film)).mtimeMs, 1_000_000);
  // out of date: replaced
  writeFileSync(localizeIn(film), 'old');
  giveLocalize(film, project);
  assert.equal(readFileSync(localizeIn(film), 'utf8'), source);
});

test('giveLocalize will not write through a link out of the project', (t) => {
  const base = folderIn('studio');
  const root = join(base, 'p');
  const film = join(root, 'f');
  mkdirSync(film, { recursive: true });
  mkdirSync(join(base, 'out'));
  writeFileSync(join(film, 'film.html'), '<p>');
  try { symlinkSync(join(base, 'out'), join(film, '.film'), 'junction'); } catch { t.skip('links cannot be made here'); return; }
  assert.throws(() => giveLocalize(film, new Project(root)), Refused);
  assert.throws(() => statSync(join(base, 'out', 'film-studio')));
});

test('films finds films to depth 3 and skips node_modules, hidden and other folders', () => {
  const root = folderIn('films');
  const project = new Project(root);
  const make = (path, at) => {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, 'film.html'), '<p>');
    utimesSync(join(root, path, 'film.html'), at, at);
  };
  make('.', 5000);
  make('a', 4000);
  make('b/c', 3000);
  make('b/c/d', 2000);
  make('b/c/d/e', 1000); // depth 4: too deep
  make('node_modules/x', 9000);
  make('.hidden/x', 9000);
  make('assets/x', 9000);
  make('vendor/x', 9000);
  make('dist/x', 9000);
  writeFileSync(join(root, 'a', 'a.mp4'), 'twelve bytes');
  const found = films(project);
  assert.deepEqual(found.map((film) => film.folder), [root, join(root, 'a'), join(root, 'b/c'), join(root, 'b/c/d')]);
  assert.deepEqual(found.map((film) => film.name), [basename(root), 'a', 'c', 'd']);
  assert.ok(found.every((film) => film.exists && film.shown === film.folder && typeof film.modified === 'string'));
  assert.deepEqual(found[1].video, { path: join(root, 'a', 'a.mp4'), shown: join(root, 'a', 'a.mp4'), bytes: 12 });
  assert.equal(found[0].video, null);
});

test('a film changes when a page, style or picture of it does, not when it is rendered', () => {
  const root = folderIn('changed');
  assert.equal(changed(root), null);
  const put = (name, at) => { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), 'x'); utimesSync(join(root, name), at, at); };
  put('film.html', 1000);
  assert.equal(changed(root), 1_000_000);
  put('title.html', 2000);
  assert.equal(changed(root), 2_000_000);
  put('assets/vendor/a/b.css', 3000);
  assert.equal(changed(root), 3_000_000);
  for (const name of ['film.mp4', 'sound.wav', '.film/cache/x.png', 'node_modules/x/y.js']) put(name, 9000);
  assert.equal(changed(root), 3_000_000);
});

test('films: none, and a project with no films', () => {
  assert.deepEqual(films(new Project(folderIn('films'))), []);
});

test('studio() says whether the editor runs, and keeps its address to itself', () => {
  assert.deepEqual(studio(), { running: false });
  mkdirSync(OPENFILM_HOME, { recursive: true });
  writeFileSync(join(OPENFILM_HOME, 'run.json'), JSON.stringify({ pid: process.pid, origin: 'http://127.0.0.1:4173', key: 'k' }));
  assert.deepEqual(studio(), { running: true });
  writeFileSync(join(OPENFILM_HOME, 'run.json'), JSON.stringify({ pid: 2 ** 22 + 12345, origin: 'x', key: 'k' }));
  assert.deepEqual(studio(), { running: false });
  writeFileSync(join(OPENFILM_HOME, 'run.json'), 'not json');
  assert.deepEqual(studio(), { running: false });
});

test('the last film opened is remembered, if it is in the project', () => {
  const root = folderIn('last');
  const project = new Project(root);
  assert.equal(lastOpened(project), null);
  noteOpened(join(root, 'f'));
  const last = lastOpened(project);
  assert.equal(last.folder, join(root, 'f'));
  assert.equal(last.shown, join(root, 'f'));
  assert.match(last.at, /^\d{4}-\d\d-\d\dT/);
  noteOpened(join(folderIn('last'), 'g'));
  assert.equal(lastOpened(project), null);
});
