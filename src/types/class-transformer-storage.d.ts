// class-transformer ships its metadata storage without a public typing; class-validator-jsonschema needs it
// to resolve `@Type(() => Nested)` into `$ref`s.
declare module 'class-transformer/cjs/storage' {
  import { type MetadataStorage } from 'class-transformer/types/MetadataStorage';

  export const defaultMetadataStorage: MetadataStorage;
}
