import { EXAMPLE_KEYS, walk } from './walk.js';

const SHAPE_KEYS = [
  'properties',
  'additionalProperties',
  'patternProperties',
  'allOf',
  'oneOf',
  'anyOf',
  '$ref',
];

// `type: object` without any declared shape is an untyped blob in the generated client.
export default function objectShape(document) {
  const results = [];
  walk(document, [], (node, path) => {
    if (EXAMPLE_KEYS.has(path.at(-1))) return false;
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes('object') && !SHAPE_KEYS.some((key) => node[key] !== undefined)) {
      results.push({ message: '`type: object` without properties/additionalProperties/composition', path });
    }
    return true;
  });
  return results;
}
