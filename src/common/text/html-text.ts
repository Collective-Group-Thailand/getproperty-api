/**
 * Plain text of an HTML document as a reader sees it (contract golden tests, fake PDFs, content hashes): block
 * elements become line breaks, table cells are separated by " | ", entities are decoded, whitespace is collapsed per
 * line, `<style>`/`<script>`/`<head>` are dropped. Deterministic and dependency-free.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>\s*<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<\/?(p|div|h[1-6]|li|tr|table|section|header|footer|ol|ul|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const entities: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&#x27;': "'",
    '&#x3D;': '=',
    '&#x60;': '`',
  };
  s = s.replace(/&(nbsp|amp|lt|gt|quot|#39|#x27|#x3D|#x60);/g, (m) => entities[m] ?? m);
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}
