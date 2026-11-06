// Parses Netflix TTML (IMSC1) subtitle documents into timed cues.

export interface Run {
  text: string;
  italic?: boolean;
  /** Shown in the language being learned. */
  l2?: boolean;
  /** The English line revealed while holding the key. */
  reveal?: boolean;
}

/** Where a subtitle file places a cue, as fractions of the picture. */
export interface CuePosition {
  /** Horizontal centre. */
  x: number;
  y: 'top' | 'bottom';
  /** Distance from the top or bottom edge. */
  offset: number;
}

export interface Cue {
  id: string;
  /** Seconds on the media timeline. */
  begin: number;
  end: number;
  /** Text with line breaks as "\n". */
  text: string;
  /** The same text as styled runs, one array per displayed line. */
  lines: Run[][];
  region?: string;
  position?: CuePosition;
}

const TTP_NS = 'http://www.w3.org/ns/ttml#parameter';
const TTS_NS = 'http://www.w3.org/ns/ttml#styling';

function styling(el: Element, name: string): string | null {
  return el.getAttributeNS(TTS_NS, name) || el.getAttribute(`tts:${name}`);
}

/** Accepts tick times ("22400000t") and clock times ("00:01:02.500"). */
export function parseTime(value: string, tickRate: number): number {
  const v = value.trim();
  if (v.endsWith('t')) return Number(v.slice(0, -1)) / tickRate;
  if (v.endsWith('ms')) return Number(v.slice(0, -2)) / 1000;
  if (v.endsWith('s')) return Number(v.slice(0, -1));
  const parts = v.split(':').map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function percentPair(value: string | null): [number, number] | null {
  const match = value?.match(/^\s*([\d.]+)%\s+([\d.]+)%\s*$/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function positionOf(el: Element): CuePosition | undefined {
  const origin = percentPair(styling(el, 'origin'));
  const extent = percentPair(styling(el, 'extent'));
  if (!origin || !extent) return undefined;
  const [left, top] = origin;
  const [width, height] = extent;
  const x = (left + width / 2) / 100;
  return top + height / 2 < 50 ? { x, y: 'top', offset: top / 100 } : { x, y: 'bottom', offset: 1 - (top + height) / 100 };
}

function collectLines(p: Element, italicStyles: Set<string>): Run[][] {
  const lines: Run[][] = [[]];
  const walk = (node: Node, inherited: boolean) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? '').replace(/\s+/g, ' ');
        if (text) lines.at(-1)!.push(inherited ? { text, italic: true } : { text });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        if (el.localName === 'br') lines.push([]);
        else walk(el, isItalic(el, inherited, italicStyles));
      }
    });
  };
  walk(p, isItalic(p, false, italicStyles));

  return lines
    .map((line) => {
      // Trim the outer edges of each line, keeping spaces between runs.
      const first = line[0];
      const last = line.at(-1);
      if (first) first.text = first.text.trimStart();
      if (last) last.text = last.text.trimEnd();
      return line.filter((run) => run.text);
    })
    .filter((line) => line.length > 0);
}

function isItalic(el: Element, inherited: boolean, italicStyles: Set<string>): boolean {
  const own = styling(el, 'fontStyle');
  if (own) return own === 'italic';
  const refs = el.getAttribute('style')?.split(/\s+/) ?? [];
  return refs.some((id) => italicStyles.has(id)) || inherited;
}

export function isTtml(text: string): boolean {
  return /<tt[\s>]/.test(text.slice(0, 2000)) && text.includes('http://www.w3.org/ns/ttml');
}

/** The document's declared language, such as "en" or "fr". */
export function ttmlLanguage(text: string): string | null {
  return /xml:lang="([^"]+)"/.exec(text.slice(0, 2000))?.[1] ?? null;
}

/** `offset` shifts every cue, for chunks whose times are relative to the chunk. */
export function parseTtml(xml: string, offset = 0): Cue[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const root = doc.documentElement;
  const tickRate =
    Number(root.getAttributeNS(TTP_NS, 'tickRate') || root.getAttribute('ttp:tickRate')) || 10_000_000;

  const italicStyles = new Set<string>();
  doc.querySelectorAll('style').forEach((style) => {
    const id = style.getAttribute('xml:id');
    if (id && styling(style, 'fontStyle') === 'italic') italicStyles.add(id);
  });
  const regions = new Map<string, CuePosition>();
  doc.querySelectorAll('region').forEach((region) => {
    const id = region.getAttribute('xml:id');
    const position = positionOf(region);
    if (id && position) regions.set(id, position);
  });

  return Array.from(doc.querySelectorAll('p')).map((p, i) => {
    const lines = collectLines(p, italicStyles);
    const region = p.getAttribute('region') ?? undefined;
    const position = positionOf(p) ?? (region ? regions.get(region) : undefined);
    return {
      id: p.getAttribute('xml:id') || p.getAttribute('id') || `p${i}`,
      begin: parseTime(p.getAttribute('begin') ?? '0', tickRate) + offset,
      end: parseTime(p.getAttribute('end') ?? '0', tickRate) + offset,
      text: lines.map((line) => line.map((run) => run.text).join('')).join('\n'),
      lines,
      ...(region ? { region } : {}),
      ...(position ? { position } : {}),
    };
  });
}
