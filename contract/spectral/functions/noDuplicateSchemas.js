// Two component schemas with the same shape (ignoring docs-only keys) should be one schema.
const DOC_KEYS = new Set(['description', 'example', 'examples', 'title', 'deprecated']);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !DOC_KEYS.has(key))
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export default function noDuplicateSchemas(schemas, _options, context) {
  const seen = new Map();
  const results = [];
  for (const [name, schema] of Object.entries(schemas ?? {})) {
    const key = JSON.stringify(canonical(schema));
    const first = seen.get(key);
    if (first)
      results.push({
        message: `schema ${name} has the same shape as ${first}`,
        path: [...context.path, name],
      });
    else seen.set(key, name);
  }
  return results;
}
