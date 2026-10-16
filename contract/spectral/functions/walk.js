// Depth-first walk over a JSON document, calling visit(node, path). Skips nothing by itself.
export function walk(node, path, visit) {
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, [...path, index], visit));
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (visit(node, path) === false) return;
  for (const [key, child] of Object.entries(node)) walk(child, [...path, key], visit);
}

export const EXAMPLE_KEYS = new Set(['example', 'examples', 'default', 'x-example']);
