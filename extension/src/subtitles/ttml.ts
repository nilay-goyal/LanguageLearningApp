// Parses Netflix TTML (IMSC1) subtitle documents into timed cues.

export interface Cue {
  id: string;
  /** Seconds on the media timeline. */
  begin: number;
  end: number;
  /** Text with line breaks as "\n". */
  text: string;
  region?: string;
}

const TTP_NS = 'http://www.w3.org/ns/ttml#parameter';

/** Accepts tick times ("22400000t") and clock times ("00:01:02.500"). */
export function parseTime(value: string, tickRate: number): number {
  const v = value.trim();
  if (v.endsWith('t')) return Number(v.slice(0, -1)) / tickRate;
  if (v.endsWith('ms')) return Number(v.slice(0, -2)) / 1000;
  if (v.endsWith('s')) return Number(v.slice(0, -1));
  const parts = v.split(':').map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function textOf(node: Node): string {
  let out = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? '';
    else if (child.nodeType === Node.ELEMENT_NODE) {
      out += (child as Element).localName === 'br' ? '\n' : textOf(child);
    }
  });
  return out;
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

  return Array.from(doc.querySelectorAll('p')).map((p, i) => ({
    id: p.getAttribute('xml:id') || p.getAttribute('id') || `p${i}`,
    begin: parseTime(p.getAttribute('begin') ?? '0', tickRate) + offset,
    end: parseTime(p.getAttribute('end') ?? '0', tickRate) + offset,
    text: textOf(p)
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n'),
    region: p.getAttribute('region') ?? undefined,
  }));
}
