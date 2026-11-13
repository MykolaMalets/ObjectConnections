import type { ExportInput, Extension } from '../api.ts';
import { arrowHead, relationCurve } from '../../view/layout.ts';
import { ATTR_STYLE, COLORS, attrColor, levelStyle } from '../../view/style.ts';

const PADDING = 24;

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (value: number) => String(Math.round(value * 10) / 10);

/**
 * Vector picture of the maps exactly as the editor lays them out. Collapsed
 * branches stay collapsed. Selection, toggles and other editing marks are not drawn.
 */
export function exportSvg(input: ExportInput): string {
  if (!input.layout) throw new Error('SVG export needs the layout and works only inside the editor');
  const { boxes, byId } = input.layout();
  if (boxes.length === 0) throw new Error('nothing to export');

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const b of boxes) {
    left = Math.min(left, b.x);
    top = Math.min(top, b.y);
    right = Math.max(right, b.x + b.w);
    bottom = Math.max(bottom, b.y + b.h);
  }
  const relations: string[] = [];
  for (const relation of Object.values(input.doc.relations)) {
    const from = byId.get(relation.from);
    const to = byId.get(relation.to);
    if (!from || !to) continue;
    const c = relationCurve(from, to);
    const [ax, ay, bx, by] = arrowHead(c.c2x, c.c2y, c.x2, c.y2);
    relations.push(
      `<path d="M${n(c.x1)} ${n(c.y1)}C${n(c.c1x)} ${n(c.c1y)} ${n(c.c2x)} ${n(c.c2y)} ${n(c.x2)} ${n(c.y2)}" fill="none" stroke="${COLORS.relation}" stroke-width="1.5" stroke-dasharray="6 4"/>`,
      `<path d="M${n(c.x2)} ${n(c.y2)}L${n(ax)} ${n(ay)}L${n(bx)} ${n(by)}Z" fill="${COLORS.relation}"/>`,
    );
    if (relation.text) {
      relations.push(
        `<text x="${n(c.mx)}" y="${n(c.my)}" font-size="12" text-anchor="middle" fill="${COLORS.relation}" stroke="${COLORS.background}" stroke-width="4" paint-order="stroke">${escapeXml(relation.text)}</text>`,
      );
    }
    // Loops and bends can leave the boxes' bounding area.
    for (const [x, y] of [[c.c1x, c.c1y], [c.c2x, c.c2y], [c.mx, c.my]] as const) {
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  const width = right - left + PADDING * 2;
  const height = bottom - top + PADDING * 2;

  const edges: string[] = [];
  const shapes: string[] = [];
  const texts: string[] = [];
  for (const box of boxes) {
    const parent = box.parentId ? byId.get(box.parentId) : undefined;
    if (parent) {
      const x1 = box.dir > 0 ? parent.x + parent.w : parent.x;
      const y1 = parent.y + parent.h / 2;
      const x2 = box.dir > 0 ? box.x : box.x + box.w;
      const y2 = box.y + box.h / 2;
      const mid = (x1 + x2) / 2;
      edges.push(`M${n(x1)} ${n(y1)}C${n(mid)} ${n(y1)} ${n(mid)} ${n(y2)} ${n(x2)} ${n(y2)}`);
    }
    const style = levelStyle(box.depth);
    if (style.fill) {
      shapes.push(
        `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" rx="${style.radius}" fill="${style.fill}"/>`,
      );
    } else {
      edges.push(`M${n(box.x)} ${n(box.y + box.h)}H${n(box.x + box.w)}`);
    }
    const weight = /^(\d+) /.exec(style.font)?.[1] ?? '400';
    box.lines.forEach((line, index) => {
      const y = box.y + style.padY + style.lineHeight * (index + 0.5);
      texts.push(
        `<text x="${n(box.x + style.padX)}" y="${n(y)}" font-size="${style.fontSize}" font-weight="${weight}" fill="${style.color}">${escapeXml(line)}</text>`,
      );
    });
    const attrTop = box.y + style.padY + style.lineHeight * box.lines.length + ATTR_STYLE.gap;
    box.attrs.forEach((line, index) => {
      const y = attrTop + ATTR_STYLE.lineHeight * (index + 0.5);
      texts.push(
        `<text x="${n(box.x + style.padX)}" y="${n(y)}" font-size="${ATTR_STYLE.fontSize}" fill="${attrColor(box.depth)}">${escapeXml(line)}</text>`,
      );
    });
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="${n(left - PADDING)} ${n(top - PADDING)} ${n(width)} ${n(height)}" font-family="system-ui, 'Segoe UI', Roboto, sans-serif" dominant-baseline="central">`,
    `<rect x="${n(left - PADDING)}" y="${n(top - PADDING)}" width="${n(width)}" height="${n(height)}" fill="${COLORS.background}"/>`,
    `<path d="${edges.join('')}" fill="none" stroke="${COLORS.edge}" stroke-width="1.5"/>`,
    ...shapes,
    ...texts,
    ...relations,
    '</svg>',
    '',
  ].join('\n');
}

export const exportSvgExtension: Extension = {
  id: 'builtin.export-svg',
  name: 'Экспорт в SVG',
  activate(ctx) {
    ctx.exporters.register({
      id: 'svg',
      title: 'Картинка SVG (.svg)',
      extension: 'svg',
      mime: 'image/svg+xml',
      run: exportSvg,
    });
  },
};
