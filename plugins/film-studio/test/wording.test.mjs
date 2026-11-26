// Mirrors check_wording() and load_i18n() in scripts/build.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RESERVED = ['cage', 'guest', 'vm', 'virtual machine', '虚拟机', '客机'];
const LOCALES = ['zh-CN', 'zh-TW', 'ru', 'ar', 'fa', 'ko', 'es', 'my', 'be', 'ps', 'prs', 'am', 'so', 'ti', 'fr'];
const read = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8'));

function problems(text) {
  const lowered = text.toLowerCase();
  const words = new Set(lowered.split(/[^a-z0-9\u0080-\u{10ffff}]+/u));
  return RESERVED.filter((word) => (word.includes(' ') || !/^[\x00-\x7f]*$/.test(word) ? lowered.includes(word) : words.has(word)));
}

test('the checker itself', () => {
  assert.deepEqual(problems('A guest in the cage'), ['cage', 'guest']);
  assert.deepEqual(problems('vmware is fine, a vm is not'), ['vm']);
  assert.deepEqual(problems('一个虚拟机'), ['虚拟机']);
  assert.deepEqual(problems('fine text'), []);
});

test('tools.json avoids the reserved words', () => {
  const raw = read('tools.json');
  const tools = Array.isArray(raw) ? raw : raw.tools;
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    const parts = [tool.name, tool.title ?? '', tool.description ?? '', String(tool.annotations?.title ?? '')];
    for (const key of ['inputSchema', 'outputSchema']) if (tool[key] != null) parts.push(JSON.stringify(tool[key]));
    assert.deepEqual(problems(parts.join(' ')), [], `tool ${tool.name}`);
  }
});

test('plugin.json avoids the reserved words in what is shown', () => {
  const data = read('plugin.json');
  const shown = [data.name, data.displayName ?? '', data.description, ...(data.contributes?.views ?? []).map((view) => view.title)];
  assert.deepEqual(problems(JSON.stringify(shown)), []);
});

test('i18n.json has every language, plain text of the right length, and avoids the reserved words', () => {
  const data = read('i18n.json');
  assert.deepEqual(LOCALES.filter((code) => !(code in data)), []);
  for (const [code, entry] of Object.entries(data)) {
    assert.match(code, /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
    assert.deepEqual(Object.keys(entry).filter((key) => !['displayName', 'description'].includes(key)), [], code);
    for (const [key, limit] of [['description', 600], ['displayName', 80]]) {
      if (key === 'displayName' && !(key in entry)) continue;
      const value = entry[key];
      assert.equal(typeof value, 'string', `${code}.${key}`);
      assert.ok(value.trim() && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value), `${code}.${key}`);
    }
    assert.deepEqual(problems(JSON.stringify(entry)), [], code);
  }
});
