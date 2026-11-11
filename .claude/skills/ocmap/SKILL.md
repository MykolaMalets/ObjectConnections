---
name: ocmap
description: Read, create and edit ObjectConnections mind maps (*.ocmap files) with the `oc` command-line tool. Use when the user asks to build or update a mind map, map a codebase or a document into a map, extend a branch of a map, or process the prompts stored in map nodes.
---

# ObjectConnections maps

A map is a `*.ocmap` file: sheets, each holding one or more trees of topics. Topics have text and may carry a note, a link, labels, attributes and a prompt for an agent.

## The tool

Run `oc` as:

```
node <repo>/packages/cli/src/main.ts <command> ...
```

`<repo>` is the folder where the ObjectConnections repository is checked out. Inside that repository `npm run oc -- <command> ...` works too. `oc help` lists every command.

## Rules

1. **Never edit a `.ocmap` file as text or JSON.** Always go through `oc`. It checks every change and writes nothing when a change is invalid.
2. **Read before writing.** Start with `oc outline <file>`; for a large map use `--depth 2` and then `--node <id>` on the branch you need. Every line ends with the node id in square brackets — ids are how you address nodes.
3. **Add branches with `oc add` and an indented outline**, not with raw operations. One command adds a whole subtree and prints the new ids.
4. **Keep topics short**: a few words, like a heading. Put explanations in the note (`oc set <file> <id> --notes "..."`).
5. **Do not restructure or delete what the user wrote unless asked.** Adding is safe; moving and removing are not.
6. The user may have the file open in the editor. The editor reloads it when it has no unsaved changes; if the user is editing at the same time, tell them a reload may be needed.
7. Use `--dry-run` when unsure whether a change is valid.

## Common tasks

### Create a map

```
oc new project.ocmap "Project name"
```

The output shows the sheet id and the id of the central topic. Then add branches under it.

### Add a branch

Write the outline to a file (two spaces per level, `- ` bullets optional) and add it under a parent:

```
oc add project.ocmap <parentId> --from branch.txt
```

A single topic: `oc add project.ocmap <parentId> --text "Topic"`. A new independent map on a sheet: `oc add project.ocmap sheet:<sheetId> --text "Second map"`.

### Change a topic

```
oc set project.ocmap <id> --text "New title" --notes "Longer explanation"
oc move project.ocmap <id> <newParentId>
oc remove project.ocmap <id>
```

### Anything else

Labels, links, attributes, relations between topics, sheets: use raw operations with `oc apply`. Their exact shape is in `<repo>/docs/FORMAT.md` (section «Операции»). Get fresh ids with `oc id 3`. Example — add a URL link and a label:

```
echo '[{"t":"patchNode","id":"<id>","patch":{"link":{"type":"url","url":"https://example.com"},"labels":["todo"]}}]' | oc apply project.ocmap
```

## Recipe: map of a codebase

1. Explore the repository: top-level layout, entry points, main modules and how they depend on each other.
2. Create the map (`oc new`) with the project name as the central topic.
3. First level: 4–8 areas by responsibility (not a copy of the folder tree). Second and third levels: modules, then key files, classes or functions.
4. Add each area with one `oc add --from`.
5. For topics that correspond to a file, attach a link with `oc apply`: `{"type":"file","path":"src/app.ts"}` (path relative to the map file) or a GitHub URL.
6. Put a one-paragraph description of what each area does in its note.
7. Show dependencies between areas as relations (`putRelation` with `from`, `to`, `text`), only the important ones.
8. When updating an existing code map, read it first and change only what differs; keep ids of unchanged topics.

To link a code map with a documentation map in the same file, create relations between the matching topics, or node links (`{"type":"node","nodeId":"<id>"}`).

## Recipe: process prompts stored in the map

The user writes a request on a topic in the editor's «Агент» panel and presses «В очередь» (or you set it with `oc set --prompt ... --prompt-status queued`). To process the queue:

1. `oc prompts <file>` — lists queued prompts with the topic path and id.
2. For each prompt: `oc set <file> <id> --prompt-status running`.
3. Read the context the prompt's scope asks for: `oc outline <file> --node <id>` (scope `subtree` or `node`) or the whole sheet (scope `sheet`).
4. Do what the prompt says — usually add or refine topics under that node.
5. Finish with `oc set <file> <id> --prompt-status done --prompt-message "what was done, in one sentence"`. On failure use `--prompt-status error` and explain in the message.

Process prompts one at a time and re-read the outline between them: an earlier prompt may have changed the map.

## Format in one paragraph

Each node: `id`, `text`, optional `notes` (Markdown), `labels`, `attrs` (values of user-defined attributes), `link` (`url` / `file` / `node`), `prompt` (`text`, `status`, `scope`), `collapsed`. Relations are directed links between any two nodes. A sheet lists the roots of its maps. Full description: `<repo>/docs/FORMAT.md`.
