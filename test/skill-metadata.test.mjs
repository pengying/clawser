import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const skill = new URL('../skills/browser-handoff/SKILL.md', import.meta.url);

async function manifest() {
  const text = await readFile(skill, 'utf8');
  const head = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(head, 'SKILL.md starts with a frontmatter block');
  const line = head[1].split('\n').find(row => row.startsWith('metadata:'));
  assert.ok(line, 'frontmatter has a metadata line');
  return JSON.parse(line.slice('metadata:'.length).trim()).openclaw;
}

test('the skill tells OpenClaw it only runs on Linux', async () => {
  assert.deepEqual((await manifest()).os, ['linux']);
});

// The CDP viewer never runs x11vnc or python3, and the box's Gateway PATH has no Xvfb.
// A binary requirement would hide the skill, and its consent rules, on hosts where the tool still works.
test('the skill names no required binaries, so OpenClaw never hides it on a working install', async () => {
  assert.equal((await manifest()).requires, undefined);
});
