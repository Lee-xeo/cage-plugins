import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';

const { renderArgs, lookArgs, parseOpen } = await import('../lib/openfilm.mjs');
const { Refused, HOME } = await import('../lib/paths.mjs');

test('renderArgs: nothing given', () => {
  assert.deepEqual(renderArgs(), ['render']);
  assert.deepEqual(renderArgs({}), ['render']);
});

test('renderArgs: range', () => {
  assert.deepEqual(renderArgs({ range: '3-6' }), ['render', '3-6']);
  assert.deepEqual(renderArgs({ range: '0.5-2.25' }), ['render', '0.5-2.25']);
  for (const bad of ['3', '3-', '-6', 'a-b', '3 - 6', '3-6; rm']) assert.throws(() => renderArgs({ range: bad }), Refused);
  assert.deepEqual(renderArgs({ range: '' }), ['render']);
});

test('renderArgs: fps, scale, workers bounds', () => {
  assert.deepEqual(renderArgs({ fps: 60 }), ['render', '--fps', '60']);
  assert.deepEqual(renderArgs({ fps: 1 }), ['render', '--fps', '1']);
  assert.deepEqual(renderArgs({ fps: 240 }), ['render', '--fps', '240']);
  assert.throws(() => renderArgs({ fps: 0 }), Refused);
  assert.throws(() => renderArgs({ fps: 241 }), Refused);
  assert.throws(() => renderArgs({ fps: 'x' }), Refused);
  assert.deepEqual(renderArgs({ scale: 0.5 }), ['render', '--scale', '0.5']);
  assert.throws(() => renderArgs({ scale: 0.05 }), Refused);
  assert.throws(() => renderArgs({ scale: 9 }), Refused);
  assert.deepEqual(renderArgs({ workers: 4 }), ['render', '--workers', '4']);
  assert.throws(() => renderArgs({ workers: 0 }), Refused);
  assert.throws(() => renderArgs({ workers: 65 }), Refused);
  assert.throws(() => renderArgs({ workers: 1.5 }), Refused);
});

test('renderArgs: flags', () => {
  assert.deepEqual(renderArgs({ uhd: true }), ['render', '--4k']);
  assert.deepEqual(renderArgs({ blur: true, alpha: true, subtitles: true }), ['render', '--blur', '--alpha', '--subtitles']);
  assert.deepEqual(renderArgs({ uhd: false, blur: false }), ['render']);
});

test('renderArgs: loudness', () => {
  assert.deepEqual(renderArgs({ loudness: true }), ['render', '--loudness=-14']);
  assert.deepEqual(renderArgs({ loudness: -16 }), ['render', '--loudness=-16']);
  assert.deepEqual(renderArgs({ loudness: false }), ['render']);
  assert.throws(() => renderArgs({ loudness: -80 }), Refused);
  assert.throws(() => renderArgs({ loudness: 0 }), Refused);
});

test('renderArgs: out expands ~', () => {
  assert.deepEqual(renderArgs({ out: '~/v/out.mp4' }), ['render', '--out', `${HOME}/v/out.mp4`]);
  assert.deepEqual(renderArgs({ out: '/x/o.mp4' }), ['render', '--out', '/x/o.mp4']);
  assert.deepEqual(renderArgs({ out: '  ' }), ['render']);
});

test('lookArgs', () => {
  assert.deepEqual(lookArgs(), ['look']);
  assert.deepEqual(lookArgs({ at: ['1.5', '3-6'] }), ['look', '1.5', '3-6']);
  assert.deepEqual(lookArgs({ at: [2] }), ['look', '2']);
  assert.throws(() => lookArgs({ at: ['soon'] }), Refused);
  assert.throws(() => lookArgs({ at: ['1;2'] }), Refused);
  assert.deepEqual(lookArgs({ what: '4.5' }), ['look', '4.5']);
  assert.deepEqual(lookArgs({ what: '~/a.html' }), ['look', `${HOME}/a.html`]);
  assert.deepEqual(lookArgs({ count: 5, full: true, loudness: true }), ['look', '--count', '5', '--full', '--loudness=-14']);
  assert.throws(() => lookArgs({ count: 0 }), Refused);
  assert.throws(() => lookArgs({ count: 201 }), Refused);
  assert.throws(() => lookArgs({ count: 2.5 }), Refused);
});

test('parseOpen: a new editor', () => {
  const out = 'project  /x/y\nStudio   http://127.0.0.1:4747/open?key=k&to=/projects/1\n         open this address in a browser\n';
  assert.deepEqual(parseOpen(out), { project: '/x/y', url: 'http://127.0.0.1:4747/open?key=k&to=/projects/1', alreadyOpen: false });
});

test('parseOpen: already open, with colour codes', () => {
  const out = '\x1b[2mproject\x1b[0m  /x/y z\nStudio   http://127.0.0.1:4747/open?key=k\n         already open in a browser, now showing this film\n';
  // colour codes in front of "project" are removed, so the line parses
  const got = parseOpen(out);
  assert.equal(got.alreadyOpen, true);
  assert.equal(got.url, 'http://127.0.0.1:4747/open?key=k');
  assert.equal(got.project, '/x/y z');
});

test('parseOpen: nothing useful', () => {
  assert.deepEqual(parseOpen('boom'), { project: null, url: null, alreadyOpen: false });
});
