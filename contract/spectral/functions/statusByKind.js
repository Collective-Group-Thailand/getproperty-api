// Status codes that follow from how an operation is documented (api-conventions §5):
// `If-Match` ⇒ 412, `Idempotency-Key` ⇒ 409 (a replay in progress), 202 ⇒ the operation to poll is named
// (`@ApiAsync`: "Poll `<operationId>` …" or "Nothing to poll.").
const refName = (parameter) => (parameter?.$ref ?? '').split('/').pop() || parameter?.name || '';

export default function statusByKind(operation, _options, context) {
  const results = [];
  const responses = operation?.responses ?? {};
  const names = (operation?.parameters ?? []).map(refName);
  const at = (...rest) => [...context.path, ...rest];

  if (names.some((n) => /^IfMatch/.test(n) || n.toLowerCase() === 'if-match') && !responses['412'])
    results.push({ message: 'If-Match operation without a 412 response', path: at('responses') });
  if (
    names.some((n) => /^IdempotencyKey/.test(n) || n.toLowerCase() === 'idempotency-key') &&
    !responses['409']
  )
    results.push({ message: 'Idempotency-Key operation without a 409 response', path: at('responses') });
  const accepted = responses['202'];
  if (
    accepted &&
    !/Poll `[a-z]+\.[A-Za-z0-9]+\.[A-Za-z0-9]+`/.test(accepted.description ?? '') &&
    !(accepted.description ?? '').endsWith('Nothing to poll.')
  )
    results.push({
      message: '202 must name the operation to poll (@ApiAsync)',
      path: at('responses', '202'),
    });
  return results;
}
