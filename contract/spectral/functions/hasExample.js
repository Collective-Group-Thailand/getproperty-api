// A media type object must carry `example` or a non-empty `examples`.
export default function hasExample(mediaType) {
  if (!mediaType || typeof mediaType !== 'object') return [];
  if (mediaType.example !== undefined) return [];
  if (mediaType.examples && Object.keys(mediaType.examples).length > 0) return [];
  return [{ message: 'body has no example (add `example` or `examples`)' }];
}
