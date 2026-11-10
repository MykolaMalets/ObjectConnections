#!/usr/bin/env node
// `oc` — command-line access to *.ocmap files for agents and scripts.
// Every change goes through the same operations the editor uses, so a file
// written by this tool always satisfies the format invariants.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Doc, Id, Op } from '@oc/core';
import {
  History,
  OpError,
  createDoc,
  getNode,
  getSheet,
  newId,
  opsFromOutline,
  parseOutline,
  pathOf,
  renderOutline,
  serializeDoc,
  validate,
} from '@oc/core';

export interface Io {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  stdin(): Promise<string>;
  out(text: string): void;
}

const HELP = `oc — read and edit ObjectConnections maps (*.ocmap)

Reading
  oc outline <file> [--sheet <id|title>] [--node <id>] [--depth <n>]
                                   tree as text; every line ends with the node [id]
  oc find <file> <text>            nodes whose text or note contains <text>
  oc get <file> <id>               one node as JSON, with its path
  oc prompts <file> [--status <queued|draft|running|done|error|all>]
                                   nodes that carry a prompt (default: queued)
  oc validate <file>               check the file

Editing (each command is one atomic change; nothing is written on error)
  oc new <file> [title]            create a map file
  oc add <file> <parentId|sheet:ID> [--from <outline file>] [--text <t>] [--index <n>]
                                   add a branch from an indented outline (stdin by default)
  oc set <file> <id> [--text <t>] [--notes <t>] [--prompt <t>]
                     [--prompt-status <s>] [--prompt-message <t>]
                                   change fields of a node; an empty value clears notes/prompt
  oc move <file> <id> <newParentId> [--index <n>]
  oc remove <file> <id>            remove a node with its subtree
  oc apply <file> [--ops <json file>] [--label <t>]
                                   apply raw operations (JSON array, stdin by default); see docs/FORMAT.md
  oc id [n]                        print n fresh ids for use in operations

Common flags
  --dry-run                        validate and report, but do not write
`;

class UsageError extends Error {}

interface Args {
  positional: string[];
  flags: Map<string, string>;
}

const BOOLEAN_FLAGS = new Set(['dry-run', 'help']);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) flags.set(name, 'true');
    else {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`flag --${name} needs a value`);
      flags.set(name, value);
    }
  }
  return { positional, flags };
}

function need(args: Args, index: number, what: string): string {
  return args.positional[index] ?? fail(`missing argument: ${what}`);
}

function fail(message: string): never {
  throw new UsageError(message);
}

function intFlag(args: Args, name: string): number | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) fail(`--${name} must be a non-negative integer`);
  return value;
}

async function load(io: Io, file: string): Promise<Doc> {
  let doc: Doc;
  try {
    doc = JSON.parse(await io.read(file)) as Doc;
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof doc !== 'object' || doc === null || doc.format !== 'ocmap') fail(`${file} is not an ocmap file`);
  const problems = validate(doc);
  if (problems.length) fail(`${file} is damaged:\n  ${problems.slice(0, 10).join('\n  ')}`);
  return doc;
}

/** Applies operations as one unit and writes the file unless --dry-run is set. */
async function mutate(io: Io, args: Args, file: string, doc: Doc, ops: Op[], label: string): Promise<void> {
  const history = new History(doc, { now: () => new Date().toISOString() });
  history.apply(ops, label);
  const problems = validate(doc);
  if (problems.length) throw new Error(`internal error, file not written: ${problems.join('; ')}`);
  if (args.flags.has('dry-run')) io.out('dry run: file not written\n');
  else await io.write(file, serializeDoc(doc));
}

function resolveSheet(doc: Doc, ref: string): Id {
  const sheet = getSheet(doc, ref) ?? doc.sheets.find((s) => s.title === ref);
  return sheet?.id ?? fail(`sheet not found: ${ref}`);
}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const args = parseArgs(argv);
    const command = args.positional[0];
    if (!command || command === 'help' || args.flags.has('help')) {
      io.out(HELP);
      return 0;
    }
    if (command === 'id') {
      const count = Math.min(1000, Math.max(1, Number(args.positional[1] ?? 1) || 1));
      for (let i = 0; i < count; i++) io.out(newId() + '\n');
      return 0;
    }
    const file = need(args, 1, 'file');

    if (command === 'new') {
      const exists = await io.read(file).then(
        () => true,
        () => false,
      );
      if (exists) fail(`${file} already exists`);
      const doc = createDoc(args.positional[2] ?? 'Central topic');
      await io.write(file, serializeDoc(doc));
      io.out(renderOutline(doc));
      return 0;
    }

    const doc = await load(io, file);
    switch (command) {
      case 'outline': {
        const sheetRef = args.flags.get('sheet');
        const options: Parameters<typeof renderOutline>[1] = {};
        if (sheetRef !== undefined) options.sheetId = resolveSheet(doc, sheetRef);
        const nodeId = args.flags.get('node');
        if (nodeId !== undefined) options.nodeId = nodeId;
        const depth = intFlag(args, 'depth');
        if (depth !== undefined) options.depth = depth;
        io.out(renderOutline(doc, options));
        return 0;
      }

      case 'find': {
        const query = need(args, 2, 'text').toLowerCase();
        let count = 0;
        for (const node of Object.values(doc.nodes)) {
          if (!node.text.toLowerCase().includes(query) && !node.notes?.toLowerCase().includes(query)) continue;
          io.out(`[${node.id}] ${pathOf(doc, node.id).join(' > ')}\n`);
          count++;
        }
        if (count === 0) io.out('no matches\n');
        return 0;
      }

      case 'get': {
        const id = need(args, 2, 'node id');
        const node = getNode(doc, id) ?? fail(`node not found: ${id}`);
        io.out(JSON.stringify({ path: pathOf(doc, id), node }, null, 1) + '\n');
        return 0;
      }

      case 'prompts': {
        const status = args.flags.get('status') ?? 'queued';
        let count = 0;
        for (const node of Object.values(doc.nodes)) {
          if (!node.prompt || (status !== 'all' && node.prompt.status !== status)) continue;
          io.out(`[${node.id}] ${node.prompt.status}, scope ${node.prompt.scope}: ${pathOf(doc, node.id).join(' > ')}\n`);
          for (const line of node.prompt.text.split('\n')) io.out(`    ${line}\n`);
          count++;
        }
        if (count === 0) io.out(`no prompts with status ${status}\n`);
        return 0;
      }

      case 'validate':
        io.out(`ok: ${Object.keys(doc.nodes).length} nodes, ${doc.sheets.length} sheets\n`);
        return 0;

      case 'add': {
        const targetRef = need(args, 2, 'parent id or sheet:ID');
        const from = args.flags.get('from');
        const text = args.flags.get('text') ?? (from !== undefined ? await io.read(from) : await io.stdin());
        const items = parseOutline(text);
        if (items.length === 0) fail('the outline is empty');
        const target: Parameters<typeof opsFromOutline>[1] = targetRef.startsWith('sheet:')
          ? { parentId: null, sheetId: resolveSheet(doc, targetRef.slice(6)) }
          : { parentId: targetRef };
        const index = intFlag(args, 'index');
        if (index !== undefined) target.index = index;
        const { ops, rootIds } = opsFromOutline(items, target);
        await mutate(io, args, file, doc, ops, 'add');
        for (const rootId of rootIds) io.out(renderOutline(doc, { nodeId: rootId }));
        return 0;
      }

      case 'set': {
        const id = need(args, 2, 'node id');
        const node = getNode(doc, id) ?? fail(`node not found: ${id}`);
        const patch: Record<string, unknown> = {};
        const text = args.flags.get('text');
        if (text !== undefined) patch.text = text;
        const notes = args.flags.get('notes');
        if (notes !== undefined) patch.notes = notes || null;
        const promptText = args.flags.get('prompt');
        const promptStatus = args.flags.get('prompt-status');
        const promptMessage = args.flags.get('prompt-message');
        if (promptText === '') patch.prompt = null;
        else if (promptText !== undefined || promptStatus !== undefined || promptMessage !== undefined) {
          const statuses = ['draft', 'queued', 'running', 'done', 'error'];
          if (promptStatus !== undefined && !statuses.includes(promptStatus)) fail(`--prompt-status must be one of ${statuses.join(', ')}`);
          const current = node.prompt;
          if (!current && promptText === undefined) fail('the node has no prompt; pass --prompt <text>');
          const prompt: Record<string, unknown> = {
            scope: 'subtree',
            ...current,
            text: promptText ?? current!.text,
            status: promptStatus ?? current?.status ?? 'draft',
          };
          if (promptMessage !== undefined) {
            if (promptMessage) prompt.message = promptMessage;
            else delete prompt.message;
          }
          patch.prompt = prompt;
        }
        if (Object.keys(patch).length === 0) fail('nothing to set');
        await mutate(io, args, file, doc, [{ t: 'patchNode', id, patch }], 'set');
        io.out(renderOutline(doc, { nodeId: id, depth: 0 }));
        return 0;
      }

      case 'move': {
        const op: Op = { t: 'moveNode', id: need(args, 2, 'node id'), parentId: need(args, 3, 'new parent id') };
        const index = intFlag(args, 'index');
        if (index !== undefined) op.index = index;
        await mutate(io, args, file, doc, [op], 'move');
        io.out(`moved: ${pathOf(doc, op.id).join(' > ')}\n`);
        return 0;
      }

      case 'remove': {
        const id = need(args, 2, 'node id');
        const path = pathOf(doc, id).join(' > ');
        await mutate(io, args, file, doc, [{ t: 'removeSubtree', id }], 'remove');
        io.out(`removed: ${path}\n`);
        return 0;
      }

      case 'apply': {
        const from = args.flags.get('ops');
        const raw = from !== undefined ? await io.read(from) : await io.stdin();
        let ops: Op[];
        try {
          ops = JSON.parse(raw) as Op[];
        } catch {
          fail('operations must be a JSON array');
        }
        if (!Array.isArray(ops) || ops.length === 0) fail('operations must be a non-empty JSON array');
        await mutate(io, args, file, doc, ops, args.flags.get('label') ?? 'apply');
        io.out(`applied ${ops.length} operation(s)\n`);
        return 0;
      }

      default:
        fail(`unknown command: ${command}. Run "oc help".`);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof OpError) {
      io.out(`error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

const nodeIo: Io = {
  read: (path) => readFile(path, 'utf8'),
  // Write next to the target and rename, so a reader never sees a half-written file.
  async write(path, text) {
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, path);
  },
  async stdin() {
    if (process.stdin.isTTY) return '';
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data;
  },
  out: (text) => process.stdout.write(text),
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2), nodeIo);
}
