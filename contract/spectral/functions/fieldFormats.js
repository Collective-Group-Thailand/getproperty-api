// Field formats (api-conventions §3, §5), over every component schema property:
// - money is a decimal string: a property declared with `Unit: THB` (DecimalField) must not be a JSON number,
//   unless it is a deprecated field kept for a migration;
// - `…At` strings are `format: date-time` (unless they declare a `pattern`, e.g. a time of day);
// - `…On` / `…Date` strings are `format: date` (or `date-time`);
// - any string whose example is an ISO date declares its format (or a pattern).
const typesOf = (schema) => {
  const own = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nested = (schema.anyOf ?? schema.oneOf ?? []).flatMap((s) => typesOf(s));
  return [...own, ...nested].filter((t) => t !== 'null');
};
const formatOf = (schema) =>
  schema.format ?? (schema.anyOf ?? schema.oneOf ?? []).map((s) => s.format).find(Boolean);

export default function fieldFormats(schemas) {
  const results = [];
  for (const [name, schema] of Object.entries(schemas ?? {})) {
    for (const [field, property] of Object.entries(schema?.properties ?? {})) {
      if (!property || typeof property !== 'object' || property.$ref) continue;
      const path = [name, 'properties', field];
      const types = typesOf(property);
      const format = formatOf(property);
      const numeric = types.some((t) => t === 'number' || t === 'integer');
      if (numeric && !property.deprecated && /Unit: THB\b/.test(property.description ?? ''))
        results.push({
          message: `${name}.${field}: money must be a decimal string, not a JSON number`,
          path,
        });
      if (!types.includes('string') || property.pattern) continue;
      const example = [property.example, ...(property.anyOf ?? []).map((s) => s.example)].find(
        (e) => e != null,
      );
      if (!format && /^\d{4}-\d{2}-\d{2}/.test(String(example ?? '')))
        results.push({ message: `${name}.${field}: a date example needs format date or date-time`, path });
      if (/At$/.test(field) && format !== 'date-time')
        results.push({ message: `${name}.${field}: a …At field needs format date-time`, path });
      if (/(On|Date)$/.test(field) && format !== 'date' && format !== 'date-time')
        results.push({ message: `${name}.${field}: a …On / …Date field needs format date`, path });
    }
  }
  return results;
}
