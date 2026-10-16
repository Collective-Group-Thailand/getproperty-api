import 'reflect-metadata';

import { DECORATORS, type OpenAPIObject } from '@nestjs/swagger';

/**
 * `@nestjs/swagger` names a component after its class, so two DTO classes with one name publish
 * as one schema and the second silently replaces the first.
 * `trackSchemaClasses()` records every class that receives `@ApiProperty` metadata; it must run
 * before any DTO module is loaded (first import of `scripts/contract-build.ts`).
 */
const classesByName = new Map<string, Set<object>>();
let tracking = false;

export function trackSchemaClasses(): void {
  if (tracking) return;
  tracking = true;
  const define = Reflect.defineMetadata.bind(Reflect);
  Reflect.defineMetadata = (key: unknown, value: unknown, target: object, property?: string | symbol) => {
    if (key === DECORATORS.API_MODEL_PROPERTIES_ARRAY && property === undefined) {
      const ctor = (target as { constructor?: { name?: string } }).constructor;
      if (typeof ctor === 'function' && ctor.name) {
        const classes = classesByName.get(ctor.name) ?? new Set<object>();
        classes.add(ctor);
        classesByName.set(ctor.name, classes);
      }
    }
    if (property === undefined) define(key, value, target);
    else define(key, value, target, property);
  };
}

/** Component schemas that more than one DTO class publishes under the same name. */
export function duplicateSchemaClasses(
  document: OpenAPIObject,
  registry: ReadonlyMap<string, ReadonlySet<object>> = classesByName,
): string[] {
  const schemas = document.components?.schemas ?? {};
  return [...registry.entries()]
    .filter(([name, classes]) => classes.size > 1 && name in schemas)
    .map(
      ([name, classes]) =>
        `component "${name}" is published by ${classes.size} different classes: rename all but one`,
    )
    .sort();
}
