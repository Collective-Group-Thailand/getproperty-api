import { EXAMPLE_KEYS, walk } from './walk.js';

// Enums must be named components (#/components/schemas/<Name> with `enum` at its root).
export default function noInlineEnum(document) {
  const results = [];
  walk(document, [], (node, path) => {
    if (EXAMPLE_KEYS.has(path.at(-1))) return false;
    const isComponentRoot = path.length === 3 && path[0] === 'components' && path[1] === 'schemas';
    if (Array.isArray(node.enum) && !isComponentRoot) {
      results.push({
        message: 'inline enum: declare it with enumName so it becomes a named component',
        path,
      });
    }
    return true;
  });
  return results;
}
