import { type Type, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import { DomainException } from '../errors/domain.exception';
import { type ProblemFieldError } from '../errors/problem-details.dto';

function joinPath(parent: string, property: string): string {
  if (/^\d+$/.test(property)) return `${parent}[${property}]`;
  return parent ? `${parent}.${property}` : property;
}

/** Flattens class-validator's error tree into `{ path, code, message }` entries (contract §3). */
export function flattenValidationErrors(errors: ValidationError[], parent = ''): ProblemFieldError[] {
  return errors.flatMap((error) => {
    const path = joinPath(parent, error.property);
    const own = Object.entries(error.constraints ?? {}).map(([code, message]) => ({ path, code, message }));
    return [...own, ...flattenValidationErrors(error.children ?? [], path)];
  });
}

/** The single global validation pipe: unknown fields are rejected, payloads are transformed to DTOs. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    stopAtFirstError: false,
    exceptionFactory: (errors) =>
      new DomainException('validation.failed', { errors: flattenValidationErrors(errors) }),
  });
}

/**
 * Validates a payload whose DTO is only known at run time (an MQTT envelope chosen by its topic, a
 * nested document), with the global pipe's rules: unknown fields refused, errors under `path`.
 */
export async function validateAs<T extends object>(dto: Type<T>, value: unknown, path = ''): Promise<T> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainException('validation.failed', {
      errors: [{ path: path || '$', code: 'isObject', message: `${path || 'payload'} must be an object` }],
    });
  }
  const instance = plainToInstance(dto, value, { enableImplicitConversion: false });
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    validationError: { target: false, value: false },
    stopAtFirstError: false,
  });
  if (errors.length > 0) {
    throw new DomainException('validation.failed', { errors: flattenValidationErrors(errors, path) });
  }
  return instance;
}
