import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRATCH, folderIn } from './helpers.mjs';

const { roots, toHost, toCaller, Project, Refused, HOME } = await import('../lib/paths.mjs');

test('roots on each system', () => {
  assert.deepEqual(roots('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a'),
    { cache: 'C:\\Users\\a\\AppData\\Local\\film-studio\\cache', data: 'C:\\Users\\a\\AppData\\Local\\film-studio\\data' });
  assert.deepEqual(roots('win32', {}, 'C:\\Users\\a'),
    { cache: 'C:\\Users\\a\\AppData\\Local\\film-studio\\cache', data: 'C:\\Users\\a\\AppData\\Local\\film-studio\\data' });
  assert.deepEqual(roots('darwin', { XDG_CACHE_HOME: '/ignored' }, '/Users/a'),
    { cache: '/Users/a/Library/Caches/film-studio', data: '/Users/a/Library/Application Support/film-studio' });
  assert.deepEqual(roots('linux', {}, '/home/a'), { cache: '/home/a/.cache/film-studio', data: '/home/a/.local/share/film-studio' });
  assert.deepEqual(roots('linux', { XDG_CACHE_HOME: '/c', XDG_DATA_HOME: '/d' }, '/home/a'), { cache: '/c/film-studio', data: '/d/film-studio' });
});

test('toHost and toCaller on Windows', () => {
  assert.equal(toHost('/d/Cage/open film－cage/a b', 'win32'), 'D:\\Cage\\open film－cage\\a b');
  assert.equal(toHost('/c', 'win32'), 'C:\\');
  assert.equal(toHost('/c/', 'win32'), 'C:\\');
  assert.equal(toHost('/dd/x', 'win32'), '/dd/x');
  assert.equal(toHost('rel/x', 'win32'), 'rel/x');
  assert.equal(toCaller('D:\\Cage\\open film－cage\\a b', 'win32'), '/d/Cage/open film－cage/a b');
  assert.equal(toCaller('D:/x/y', 'win32'), '/d/x/y');
  assert.equal(toCaller('D:\\', 'win32'), '/d');
  assert.equal(toCaller('D:', 'win32'), '/d');
  assert.equal(toCaller('rel\\x', 'win32'), 'rel\\x');
  for (const p of ['/d/Cage/open film－cage/a b', '/c/x', '/z']) assert.equal(toCaller(toHost(p, 'win32'), 'win32'), p);
  for (const p of ['D:\\Cage\\open film－cage\\a b', 'E:\\x']) assert.equal(toHost(toCaller(p, 'win32'), 'win32'), p);
});

test('toHost and toCaller change nothing elsewhere', () => {
  for (const platform of ['linux', 'darwin']) {
    for (const p of ['/d/x', 'D:\\x', '/home/a b', 'rel']) {
      assert.equal(toHost(p, platform), p);
      assert.equal(toCaller(p, platform), p);
    }
  }
});

function setup() {
  const base = folderIn('paths');
  const root = join(base, 'p');
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(join(base, 'p2'));
  mkdirSync(join(base, 'outside'));
  writeFileSync(join(base, 'outside', 'f.txt'), 'x');
  return { base, root, project: new Project(root) };
}

test('Project needs an absolute folder', () => {
  assert.throws(() => new Project('rel/x'), Refused);
  assert.throws(() => new Project(undefined), Refused);
  assert.throws(() => new Project(''), Refused);
});

test('Project.inside: relative and absolute paths inside', () => {
  const { root, project } = setup();
  assert.equal(project.inside('a/b.txt'), join(root, 'a', 'b.txt'));
  assert.equal(project.inside('./a/../b'), join(root, 'b'));
  assert.equal(project.inside(join(root, 'sub', 'x')), join(root, 'sub', 'x'));
  assert.equal(project.inside(root), root);
  assert.equal(project.inside('  a '), join(root, 'a'));
  assert.equal(project.inside('x', 'what', join(root, 'sub')), join(root, 'sub', 'x'));
});

test('Project.inside refuses what is not a path inside', () => {
  const { base, root, project } = setup();
  for (const bad of ['..', '../x', 'a/../../x', 'sub/../..', join(base, 'outside'), join(base, 'outside', 'f.txt'), '/etc/passwd', '/',
    '~', '~/x', '~root', '//host/share', '//x', '\\\\host\\share', 'a\0b', 'a\nb', 'a\rb', 'a\tb', '', '   ', undefined, null, 5, {}]) {
    assert.throws(() => project.inside(bad), Refused, JSON.stringify(bad));
  }
  assert.throws(() => project.inside('../x', 'out'), /out must be inside/);
  assert.throws(() => project.inside('x', 'out', join(base, 'outside')), Refused);
  assert.ok(root);
});

test('Project.inside refuses a path that only shares the project\'s prefix', () => {
  const { base, project } = setup();
  assert.throws(() => project.inside(join(base, 'p2')), Refused);
  assert.throws(() => project.inside(join(base, 'p2', 'f')), Refused);
  assert.throws(() => project.inside('../p2/f'), Refused);
});

test('Project.inside follows links: existing and not yet existing children', (t) => {
  const { base, root, project } = setup();
  try { symlinkSync(join(base, 'outside'), join(root, 'out'), 'junction'); } catch { t.skip('links cannot be made here'); return; }
  symlinkSync(join(root, 'sub'), join(root, 'in'), 'junction');
  assert.throws(() => project.inside('out'), Refused);
  assert.throws(() => project.inside('out/f.txt'), Refused);
  assert.throws(() => project.inside('out/new/child/deep.txt'), Refused);
  assert.throws(() => project.inside(join(root, 'out', 'new')), Refused);
  assert.equal(project.inside('in/new/child'), join(root, 'sub', 'new', 'child'));
  // a link to a file outside
  let linked = true;
  try { symlinkSync(join(base, 'outside', 'f.txt'), join(root, 'file-link')); } catch { linked = false; } // Windows may not let files be linked
  if (linked) assert.throws(() => project.inside('file-link'), Refused);
  // a project that is itself reached through a link
  symlinkSync(root, join(base, 'alias'), 'junction');
  const alias = new Project(join(base, 'alias'));
  assert.equal(alias.root, root);
  assert.equal(alias.inside('a'), join(root, 'a'));
});

test('Project.film refuses hidden folders', () => {
  const { root, project } = setup();
  assert.equal(project.film('my film'), join(root, 'my film'));
  assert.equal(project.film('a/b'), join(root, 'a', 'b'));
  for (const bad of ['.film', '.hidden/x', 'a/.git', 'a/.film/x', join(root, '.x')]) assert.throws(() => project.film(bad), /hidden/, bad);
  assert.throws(() => project.film('../x'), Refused);
});

test('Project.shown and Project.text', () => {
  const { root, project } = setup();
  assert.equal(project.shown(join(root, 'a', 'b')), toCaller(join(project.given, 'a', 'b')));
  assert.equal(project.shown('/somewhere/else'), '/somewhere/else');
  assert.equal(project.shown(5), 5);
  const out = project.text(`wrote ${root}/a/b.mp4, and ${root}2/x, ${root}.bak and ${root}`);
  assert.equal(out, `wrote ${toCaller(project.given)}/a/b.mp4, and ${root}2/x, ${root}.bak and ${toCaller(project.given)}`.replaceAll(HOME, '~'));
});

test('Project.text: files named from the film, on Windows', { skip: process.platform !== 'win32' }, () => {
  const { root, project } = setup();
  assert.equal(project.text('→ .film\\cache\\look\\1.5s.jpg\nsays a\\b\n'), '→ .film/cache/look/1.5s.jpg\nsays a\\b\n');
  assert.equal(project.text(`  → ${root}\\a b\\x.mp4`), `  → ${toCaller(root)}/a b/x.mp4`);
});

test('Project.text shows home as ~ elsewhere but never inside the project', () => {
  const root = join(HOME, 'films');
  mkdirSync(join(root, 'f'), { recursive: true });
  const project = new Project(root);
  const out = project.text(`in ${root}/f/a.png and ${HOME}/.cache/x and ${HOME}`);
  assert.ok(out.includes(`${toCaller(project.given)}/f/a.png`), out);
  assert.ok(out.includes('~/.cache/x') && out.endsWith(' ~'), out);
  assert.ok(!out.includes('~/films'), out);
  assert.ok(SCRATCH);
});

test('Project.noLinksOut', (t) => {
  const { base, root, project } = setup();
  const film = join(root, 'film');
  mkdirSync(join(film, 'deep'), { recursive: true });
  project.noLinksOut(film);
  project.noLinksOut(join(root, 'not-there'));
  try { symlinkSync(join(root, 'sub'), join(film, 'ok'), 'junction'); } catch { t.skip('links cannot be made here'); return; }
  project.noLinksOut(film);
  symlinkSync(join(base, 'outside'), join(film, 'deep', 'bad'), 'junction');
  assert.throws(() => project.noLinksOut(film), /link out of the project/);
});
