// Visual constants shared by text measurement, rendering and the text editor overlay.

import type { Measure, TextSize } from './layout.ts';

export interface LevelStyle {
  font: string;
  fontSize: number;
  lineHeight: number;
  padX: number;
  padY: number;
  radius: number;
  fill: string | null;
  color: string;
}

const FAMILY = 'system-ui, "Segoe UI", Roboto, sans-serif';

const LEVELS: LevelStyle[] = [
  { font: `600 20px ${FAMILY}`, fontSize: 20, lineHeight: 26, padX: 22, padY: 14, radius: 10, fill: '#2f6fed', color: '#ffffff' },
  { font: `500 15px ${FAMILY}`, fontSize: 15, lineHeight: 20, padX: 14, padY: 8, radius: 8, fill: '#e4ecfc', color: '#16284a' },
  { font: `13px ${FAMILY}`, fontSize: 13, lineHeight: 18, padX: 8, padY: 5, radius: 6, fill: null, color: '#1f2733' },
];

export const COLORS = {
  background: '#f7f8fa',
  edge: '#9fb2d4',
  selection: '#ff8a00',
  dropTarget: '#1aa260',
  toggleFill: '#ffffff',
  toggleStroke: '#8191ad',
  relation: '#c2410c',
  match: '#ffd54a',
};

export const MAX_TEXT_WIDTH = 320;

/** Attribute lines under a topic's text. */
export const ATTR_STYLE = { font: `11px ${FAMILY}`, fontSize: 11, lineHeight: 15, gap: 3 };

/** Attribute text colour: light on the filled root, muted elsewhere. */
export const attrColor = (depth: number) => (depth === 0 ? 'rgba(255,255,255,0.85)' : '#5b6b85');

export function levelStyle(depth: number): LevelStyle {
  return LEVELS[Math.min(depth, LEVELS.length - 1)]!;
}

/** Creates a caching text measurer backed by a canvas context. */
export function createMeasure(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): Measure {
  const cache = new Map<string, TextSize>();
  return (text, depth, attrs) => {
    const level = Math.min(depth, LEVELS.length - 1);
    const key = attrs?.length ? `${level}|${text}|${attrs.join('\n')}` : `${level}|${text}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const style = LEVELS[level]!;
    ctx.font = style.font;
    const lines: string[] = [];
    let width = 0;
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(' ')) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(candidate).width > MAX_TEXT_WIDTH) {
          lines.push(line);
          width = Math.max(width, ctx.measureText(line).width);
          line = word;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
      width = Math.max(width, ctx.measureText(line).width);
    }
    let attrHeight = 0;
    let shortened: string[] | undefined;
    if (attrs?.length) {
      ctx.font = ATTR_STYLE.font;
      shortened = attrs.map((line) => {
        let fitted = line;
        while (fitted.length > 1 && ctx.measureText(fitted).width > MAX_TEXT_WIDTH) fitted = fitted.slice(0, -2) + '…';
        width = Math.max(width, ctx.measureText(fitted).width);
        return fitted;
      });
      attrHeight = ATTR_STYLE.gap + shortened.length * ATTR_STYLE.lineHeight;
    }
    const size: TextSize = {
      w: Math.ceil(Math.max(width, 16)) + style.padX * 2,
      h: lines.length * style.lineHeight + attrHeight + style.padY * 2,
      lines,
      ...(shortened ? { attrs: shortened } : {}),
    };
    if (cache.size > 20000) cache.clear();
    cache.set(key, size);
    return size;
  };
}
