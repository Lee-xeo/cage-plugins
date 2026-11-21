import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { ENV } from './helpers.mjs';

mkdirSync(ENV.HOME, { recursive: true });
const paths = await import('../lib/paths.mjs');
const { HOME, Refused, shown, expandHome, filmFolder, projectsFolder } = paths;

test('plugin state lives under the temp XDG folders', () => {
  assert.equal(HOME, ENV.HOME);
  assert.ok(paths.CACHE.startsWith(ENV.XDG_CACHE_HOME));
  assert.ok(paths.DATA.startsWith(ENV.XDG_DATA_HOME));
});

test('shown writes the home folder as ~', () => {
  assert.equal(shown(HOME), '~');
  assert.equal(shown(`${HOME}/a/b`), '~/a/b');
  assert.equal(shown(`${HOME}x/a`), `${HOME}x/a`);
  assert.equal(shown('/opt/x'), '/opt/x');
  assert.equal(shown(5), 5);
});

test('expandHome', () => {
  assert.equal(expandHome('~'), HOME);
  assert.equal(expandHome('~/films/a'), `${HOME}/films/a`);
  assert.equal(expandHome('~other/x'), '~other/x');
  assert.equal(expandHome('/abs'), '/abs');
});

test('filmFolder accepts absolute, ~ and trailing slashes', () => {
  assert.equal(filmFolder('/srv/films/a'), '/srv/films/a');
  assert.equal(filmFolder('/srv/films/a/'), '/srv/films/a');
  assert.equal(filmFolder('/srv/films/a///'), '/srv/films/a');
  assert.equal(filmFolder('/srv/films/../b'), '/srv/b');
  assert.equal(filmFolder('~/films/a'), `${HOME}/films/a`);
  assert.equal(filmFolder('  ~/films/a/  '), `${HOME}/films/a`);
});

test('filmFolder makes a bare name in the projects folder', () => {
  assert.equal(filmFolder('mine'), `${projectsFolder()}/mine`);
  assert.equal(projectsFolder(), `${HOME}/Videos/OpenFilm/Projects`);
});

test('filmFolder refuses what would land in the wrong place', () => {
  for (const bad of ['a/b', './a', '../a', '.', '..', '/', '~', `${HOME}`, `${HOME}/`, '', '   ', 'a\0b', '/x/a\0b', '/x\ny', undefined, null, 5]) {
    assert.throws(() => filmFolder(bad), Refused, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.throws(() => filmFolder('a/b'), /absolute/);
});
