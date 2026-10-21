import { type SettingDef } from './catalogue';

const DECIMAL = /^-?\d+(\.\d+)?$/;
const MONEY = /^-?\d+\.\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;

/** Validates a setting value against its catalogue type and allowed values; returns problems. */
export function settingValueProblems(
  def: Pick<SettingDef, 'valueType' | 'allowedValues' | 'check'>,
  value: unknown,
): string[] {
  const problems: string[] = [];
  switch (def.valueType) {
    case 'string':
      if (typeof value !== 'string' || value.length === 0 || value.length > 500)
        problems.push('must be a string');
      break;
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) problems.push('must be an integer');
      break;
    case 'decimal':
      if (typeof value !== 'string' || !DECIMAL.test(value)) problems.push('must be a decimal string');
      break;
    case 'money':
      if (typeof value !== 'string' || !MONEY.test(value))
        problems.push('must be a money string with 2 decimals');
      break;
    case 'bool':
      if (typeof value !== 'boolean') problems.push('must be true or false');
      break;
    case 'date':
      if (typeof value !== 'string' || !DATE.test(value)) problems.push('must be a date YYYY-MM-DD');
      break;
    case 'time':
      if (typeof value !== 'string' || !TIME.test(value)) problems.push('must be a time HH:MM');
      break;
    case 'duration':
      if (typeof value !== 'string' || !DURATION.test(value)) problems.push('must be an ISO 8601 duration');
      break;
    case 'json':
      if (value === undefined || typeof value === 'function') problems.push('must be JSON');
      break;
  }
  if (def.check && !problems.length) problems.push(...def.check(value));
  if (def.allowedValues && !def.allowedValues.some((a) => JSON.stringify(a) === JSON.stringify(value)))
    problems.push(`must be one of ${def.allowedValues.map((v) => JSON.stringify(v)).join(', ')}`);
  return problems;
}
