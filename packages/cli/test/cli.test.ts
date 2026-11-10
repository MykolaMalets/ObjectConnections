import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc } from '@oc/core';
import { parseOutline, validate } from '@oc/core';
import type { Io } from '../src/main.ts';
import { run } from '../src/main.ts';

/** In-memory file system and captured output. */
function harness(stdin = '') {
  const files = new Map<string, string>();
  let output = '';
  const io: Io = {
    read: async (path) => files.get(path) ?? Promise.reject(new Error(`ENOENT: ${path}`)),
    write: async (path, text) => void files.set(path, text),
    stdin: async () => stdin,
    out: (text) => void (output += text),
  };
  return {
    files,
    io,
    doc: () => JSON.parse(files.get('m.ocmap')!) as Doc,
    async oc(...argv: string[]) {
      output = '';
      const code = await run(argv, io);
      return { code, output };
    },
  };
}

const idIn = (line: string) => /\[([0-9A-Za-z]{12})\]/.exec(line)![1]!;

test('new, add from outline, outline, find, get', async () => {
  const h = harness('- Core\n  - Ops\n  - History\n- App\n');
  const created = await h.oc('new', 'm.ocmap', 'Project');
  assert.equal(created.code, 0);
  const root = idIn(created.output.split('\n')[1]!);

  const added = await h.oc('add', 'm.ocmap', root);
  assert.equal(added.code, 0);
  assert.match(added.output, /^- Core \[\w{12}\]\n {2}- Ops \[\w{12}\]\n {2}- History \[\w{12}\]\n- App \[\w{12}\]\n$/);
  assert.deepEqual(validate(h.doc()), []);
  assert.equal(Object.keys(h.doc().nodes).length, 5);
  assert.ok(h.doc().nodes[idIn(added.output)]!.modified);

  const outline = await h.oc('outline', 'm.ocmap', '--depth', '1');
  assert.match(outline.output, /# Sheet: Sheet 1 \[\w{12}\]\n- Project \[\w{12}\]\n {2}- Core \[\w{12}\]\n {4}… 2 more below; use --node \w{12}\n {2}- App/);

  const found = await h.oc('find', 'm.ocmap', 'hist');
  assert.match(found.output, /^\[\w{12}\] Project > Core > History\n$/);
  const got = await h.oc('get', 'm.ocmap', idIn(found.output));
  assert.deepEqual(JSON.parse(got.output).path, ['Project', 'Core', 'History']);
});

test('outline output can be fed back to add', () => {
  const items = parseOutline('# Sheet: S [abcdefghijkl]\n- A [0123456789ab] {note; #x}\n  - B [0123456789ac]\n');
  assert.deepEqual(items, [{ text: 'A', children: [{ text: 'B', children: [] }] }]);
});

test('set, prompts workflow, move, remove', async () => {
  const h = harness();
  const root = idIn((await h.oc('new', 'm.ocmap', 'Root')).output.split('\n')[1]!);
  const a = idIn((await h.oc('add', 'm.ocmap', root, '--text', 'A')).output);
  const b = idIn((await h.oc('add', 'm.ocmap', root, '--text', 'B')).output);

  assert.equal((await h.oc('set', 'm.ocmap', a, '--prompt-status', 'queued')).code, 1);
  await h.oc('set', 'm.ocmap', a, '--prompt', 'Expand this branch', '--prompt-status', 'queued', '--notes', 'n');
  const queued = await h.oc('prompts', 'm.ocmap');
  assert.equal(queued.output, `[${a}] queued, scope subtree: Root > A\n    Expand this branch\n`);

  await h.oc('set', 'm.ocmap', a, '--prompt-status', 'done', '--prompt-message', 'added 3 topics');
  assert.deepEqual(h.doc().nodes[a]!.prompt, {
    scope: 'subtree',
    text: 'Expand this branch',
    status: 'done',
    message: 'added 3 topics',
  });
  assert.match((await h.oc('prompts', 'm.ocmap')).output, /no prompts with status queued/);
  await h.oc('set', 'm.ocmap', a, '--prompt', '', '--notes', '');
  assert.equal('prompt' in h.doc().nodes[a]!, false);
  assert.equal('notes' in h.doc().nodes[a]!, false);

  assert.equal((await h.oc('move', 'm.ocmap', b, a)).output, 'moved: Root > A > B\n');
  assert.equal((await h.oc('remove', 'm.ocmap', a)).output, 'removed: Root > A\n');
  assert.equal(Object.keys(h.doc().nodes).length, 1);
});

test('apply is atomic; errors and dry runs leave the file untouched', async () => {
  const h = harness();
  const root = idIn((await h.oc('new', 'm.ocmap', 'Root')).output.split('\n')[1]!);
  const before = h.files.get('m.ocmap');

  h.files.set('ops.json', JSON.stringify([
    { t: 'patchNode', id: root, patch: { text: 'Changed' } },
    { t: 'removeSubtree', id: 'missing' },
  ]));
  const bad = await h.oc('apply', 'm.ocmap', '--ops', 'ops.json');
  assert.equal(bad.code, 1);
  assert.match(bad.output, /^error: node not found: missing/);
  assert.equal(h.files.get('m.ocmap'), before);

  h.files.set('ops.json', JSON.stringify([{ t: 'patchNode', id: root, patch: { text: 'Changed' } }]));
  const dry = await h.oc('apply', 'm.ocmap', '--ops', 'ops.json', '--dry-run');
  assert.equal(dry.code, 0);
  assert.equal(h.files.get('m.ocmap'), before);
  assert.equal((await h.oc('apply', 'm.ocmap', '--ops', 'ops.json')).output, 'applied 1 operation(s)\n');
  assert.equal(h.doc().nodes[root]!.text, 'Changed');

  assert.equal((await h.oc('new', 'm.ocmap')).code, 1);
  assert.equal((await h.oc('outline', 'nope.ocmap')).code, 1);
  assert.equal((await h.oc('frobnicate', 'm.ocmap')).code, 1);
  h.files.set('bad.ocmap', '{"format":"ocmap","version":1,"sheets":[{"id":"s","title":"t","rootIds":["x"]}],"nodes":{},"relations":{},"attrDefs":{}}');
  assert.match((await h.oc('validate', 'bad.ocmap')).output, /is damaged/);
});
