import type { Doc, Id } from '@oc/core';
import type { ExportInput, Extension } from '../api.ts';

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ').trim();

function title(doc: Doc, id: Id): string {
  const node = doc.nodes[id]!;
  const text = oneLine(node.text) || '…';
  return node.link?.type === 'url' ? `[${text}](${node.link.url})` : text;
}

function attributes(doc: Doc, id: Id): string {
  const attrs = doc.nodes[id]!.attrs;
  if (!attrs) return '';
  const parts = Object.entries(attrs).map(([defId, value]) => {
    const shown = Array.isArray(value) ? value.join(', ') : String(value);
    return `${doc.attrDefs[defId]?.name ?? defId}: ${shown}`;
  });
  return parts.length ? ` *(${parts.join('; ')})*` : '';
}

/** Map roots become `#`, main branches `##`, everything deeper a nested list. Notes follow their node. */
export function exportMarkdown({ doc, rootIds }: ExportInput): string {
  const out: string[] = [];
  const walk = (id: Id, depth: number): void => {
    const node = doc.nodes[id]!;
    const line = title(doc, id) + attributes(doc, id);
    if (depth < 2) {
      if (out.length) out.push('');
      out.push(`${'#'.repeat(depth + 1)} ${line}`, '');
      if (node.notes) out.push(node.notes.trim(), '');
    } else {
      const indent = '  '.repeat(depth - 2);
      out.push(`${indent}- ${line}`);
      if (node.notes) for (const noteLine of node.notes.trim().split('\n')) out.push(`${indent}  ${noteLine}`);
    }
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const rootId of rootIds) walk(rootId, 0);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export const exportMarkdownExtension: Extension = {
  id: 'builtin.export-markdown',
  name: 'Экспорт в Markdown',
  activate(ctx) {
    ctx.exporters.register({
      id: 'markdown',
      title: 'Markdown (.md)',
      extension: 'md',
      mime: 'text/markdown',
      run: exportMarkdown,
    });
  },
};
