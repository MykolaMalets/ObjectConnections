// A small, forgiving XML reader for importers. Enough for FreeMind files and the
// XHTML inside them: elements, attributes, text, entities, CDATA, comments.
// Not a validating parser. No DOM: runs in Node tests and in the CLI.

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

/** HTML elements that never have a closing tag. */
const VOID = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'col', 'area', 'base', 'wbr']);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

/** Parses a document and returns its root element. Throws on input without any element. */
export function parseXml(text: string): XmlElement {
  const top: XmlElement = { name: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [top];
  const current = () => stack[stack.length - 1]!;
  let at = 0;
  while (at < text.length) {
    const lt = text.indexOf('<', at);
    if (lt < 0) {
      pushText(current(), decodeEntities(text.slice(at)));
      break;
    }
    if (lt > at) pushText(current(), decodeEntities(text.slice(at, lt)));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      at = end < 0 ? text.length : end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      pushText(current(), text.slice(lt + 9, end < 0 ? text.length : end));
      at = end < 0 ? text.length : end + 3;
    } else if (text[lt + 1] === '?' || text[lt + 1] === '!') {
      const end = text.indexOf('>', lt);
      at = end < 0 ? text.length : end + 1;
    } else if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      const name = text.slice(lt + 2, end < 0 ? text.length : end).trim().toLowerCase();
      at = end < 0 ? text.length : end + 1;
      // Close up to the matching element; a stray closing tag is ignored.
      const index = stack.map((e) => e.name).lastIndexOf(name);
      if (index > 0) stack.length = index;
    } else {
      const tag = readTag(text, lt);
      at = tag.end;
      const element: XmlElement = { name: tag.name, attrs: tag.attrs, children: [] };
      current().children.push(element);
      if (!tag.selfClosing && !VOID.has(tag.name)) stack.push(element);
    }
  }
  const root = top.children.find((c): c is XmlElement => typeof c !== 'string');
  if (!root) throw new Error('в файле нет XML');
  return root;
}

function pushText(parent: XmlElement, text: string): void {
  if (!text) return;
  const last = parent.children[parent.children.length - 1];
  if (typeof last === 'string') parent.children[parent.children.length - 1] = last + text;
  else parent.children.push(text);
}

function readTag(text: string, start: number): { name: string; attrs: Record<string, string>; selfClosing: boolean; end: number } {
  let at = start + 1;
  const nameMatch = /^[^\s/>]+/.exec(text.slice(at));
  const name = (nameMatch?.[0] ?? '').toLowerCase();
  at += name.length;
  const attrs: Record<string, string> = {};
  const attr = /\s*([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y;
  for (;;) {
    while (/\s/.test(text[at] ?? '')) at++;
    if (at >= text.length) return { name, attrs, selfClosing: false, end: text.length };
    if (text[at] === '>') return { name, attrs, selfClosing: false, end: at + 1 };
    if (text.startsWith('/>', at)) return { name, attrs, selfClosing: true, end: at + 2 };
    attr.lastIndex = at;
    const m = attr.exec(text);
    if (!m) return { name, attrs, selfClosing: false, end: text.indexOf('>', at) + 1 || text.length };
    attrs[m[1]!.toUpperCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    at = attr.lastIndex;
  }
}

export const elements = (element: XmlElement, name?: string): XmlElement[] =>
  element.children.filter((c): c is XmlElement => typeof c !== 'string' && (!name || c.name === name));

const BLOCKS = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'pre', 'blockquote']);

/** Readable plain text of an (X)HTML fragment: blocks and <br> become line breaks. */
export function htmlToText(element: XmlElement): string {
  let out = '';
  const walk = (node: XmlNode, pre: boolean): void => {
    if (typeof node === 'string') {
      out += pre ? node : node.replace(/\s+/g, ' ');
      return;
    }
    if (node.name === 'head' || node.name === 'style' || node.name === 'script') return;
    if (node.name === 'br') {
      out += '\n';
      return;
    }
    // A block starts and ends a line; neighbouring blocks are not separated by an empty line.
    const block = BLOCKS.has(node.name);
    const newLine = () => {
      if (out && !out.endsWith('\n')) out += '\n';
    };
    if (block) newLine();
    if (node.name === 'li') out += '- ';
    for (const child of node.children) walk(child, pre || node.name === 'pre');
    if (block) newLine();
  };
  walk(element, false);
  return out
    .split('\n')
    .map((line) => line.replace(/ /g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
