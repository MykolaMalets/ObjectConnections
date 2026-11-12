// PDF export: the SVG picture of the maps, rasterised by the editor, on one
// page sized to the map. The text is part of the picture and cannot be
// selected: a vector PDF with Cyrillic needs an embedded font, which is a
// larger task (see docs/BACKLOG.md). The PDF writer itself has no DOM and is
// tested in Node.

import type { ExportInput, Extension } from '../api.ts';
import { exportSvg } from './exportSvg.ts';
import { concat } from './zip.ts';

/** CSS pixels to PDF points (96 dpi to 72 dpi). */
const PT_PER_PX = 0.75;
/** PDF readers refuse pages larger than 200 inches. */
const MAX_PAGE_PT = 14_400;

/** PDF text string: ASCII as is, anything else as UTF-16BE hex with a byte order mark. */
function pdfString(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

/** One page showing a JPEG image stretched to the page. */
export function buildPdf(jpeg: Uint8Array, image: { width: number; height: number }, page: { width: number; height: number }, title: string): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: Uint8Array | string) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (body: string | (() => void)) => {
    offsets.push(length);
    push(`${offsets.length} 0 obj\n`);
    if (typeof body === 'string') push(body);
    else body();
    push('\nendobj\n');
  };
  const w = Math.round(page.width * 100) / 100;
  const h = Math.round(page.height * 100) / 100;
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;

  push('%PDF-1.4\n');
  // A comment of high bytes tells transfer tools that the file is binary.
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  object('<< /Type /Catalog /Pages 2 0 R >>');
  object('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  object(() => {
    push(
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    );
    push(jpeg);
    push('\nendstream');
  });
  object(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  object(`<< /Title ${pdfString(title)} /Producer (ObjectConnections) >>`);

  const xref = length;
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R /Info ${offsets.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return concat(parts);
}

/** Page size in points for a picture of `width` × `height` CSS pixels. */
export function pageSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(PT_PER_PX, MAX_PAGE_PT / width, MAX_PAGE_PT / height);
  return { width: width * scale, height: height * scale };
}

export async function exportPdf(input: ExportInput): Promise<Blob> {
  if (!input.rasterize) throw new Error('PDF export needs the editor to draw the picture');
  const svg = exportSvg(input);
  const size = /<svg[^>]* width="([\d.]+)" height="([\d.]+)"/.exec(svg);
  if (!size) throw new Error('no picture size');
  const picture = await input.rasterize(svg);
  const pdf = buildPdf(picture.jpeg, picture, pageSize(Number(size[1]), Number(size[2])), input.name);
  return new Blob([pdf as BlobPart], { type: 'application/pdf' });
}

export const exportPdfExtension: Extension = {
  id: 'builtin.export-pdf',
  name: 'Экспорт в PDF',
  activate(ctx) {
    ctx.exporters.register({
      id: 'pdf',
      title: 'PDF (.pdf)',
      extension: 'pdf',
      mime: 'application/pdf',
      run: exportPdf,
    });
  },
};
