// 2xx + 500; at least one 4xx (not required for ops.*); 401/403 when secured; 400/422 with a request
// body; every 4xx/5xx only as application/problem+json referencing ProblemDetails.
const PROBLEM = '#/components/schemas/ProblemDetails';

export default function responseSet(operation, _options, context) {
  const results = [];
  const responses = operation?.responses ?? {};
  const statuses = Object.keys(responses);
  const at = (...rest) => [...context.path, ...rest];
  const need = (status, why) => {
    if (!statuses.includes(status))
      results.push({ message: `missing ${status} response (${why})`, path: at('responses') });
  };

  if (!statuses.some((s) => s.startsWith('2')))
    results.push({ message: 'missing a 2xx response', path: at('responses') });
  need('500', 'every operation can fail unexpectedly');

  const isOps = (operation.tags ?? []).some((tag) => tag.startsWith('ops.'));
  if (!isOps && !statuses.some((s) => s.startsWith('4'))) {
    results.push({ message: 'missing 4xx responses', path: at('responses') });
  }
  const secured =
    Array.isArray(operation.security) && operation.security.some((req) => Object.keys(req).length > 0);
  if (secured) {
    need('401', 'secured operation');
    need('403', 'secured operation');
  }
  if (operation.requestBody) {
    need('400', 'operation has a request body');
    need('422', 'operation has a request body');
  }

  for (const status of statuses.filter((s) => /^[45]/.test(s))) {
    const content = responses[status]?.content ?? {};
    const types = Object.keys(content);
    if (types.length !== 1 || types[0] !== 'application/problem+json') {
      results.push({
        message: `${status} must be application/problem+json only`,
        path: at('responses', status),
      });
      continue;
    }
    if (content['application/problem+json']?.schema?.$ref !== PROBLEM) {
      results.push({ message: `${status} must reference ${PROBLEM}`, path: at('responses', status) });
    }
  }
  return results;
}
