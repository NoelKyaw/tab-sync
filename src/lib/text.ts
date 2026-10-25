// Pure text helpers for rendering.

export interface Segment {
  text: string;
  hit: boolean;
}

/** Split `text` into segments, marking every case-insensitive occurrence of any term. */
export function highlight(text: string, terms: readonly string[]): Segment[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const hits = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    for (let i = lower.indexOf(term); term && i !== -1; i = lower.indexOf(term, i + 1)) {
      hits.fill(true, i, i + term.length);
    }
  }
  const segments: Segment[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = segments[segments.length - 1];
    if (last && last.hit === hits[i]) last.text += text[i];
    else segments.push({ text: text[i]!, hit: hits[i]! });
  }
  return segments;
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function timeAgo(thenMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return `${Math.round(d / 7)}w ago`;
}
