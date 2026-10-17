import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';

/** Money on the wire (contract §3, D-046): a decimal string with up to 2 decimals in requests, exactly 2 in responses. */
export const MONEY_REQUEST = /^\d{1,12}(\.\d{1,2})?$/;
export const MONEY_RESPONSE = '^-?\\d{1,12}\\.\\d{2}$';
/** Small decimals (months, multipliers, registers, areas) as strings. */
export const DECIMAL_REQUEST = /^\d{1,9}(\.\d{1,6})?$/;

const trimString = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/** A money input field: decimal string, THB. */
export function MoneyInput(options: {
  example: string;
  description: string;
  optional?: boolean;
  nullable?: boolean;
}) {
  const doc = {
    type: String,
    example: options.example,
    pattern: MONEY_REQUEST.source,
    description: `${options.description} Unit: THB, decimal string (D-046).`,
    ...(options.nullable ? { nullable: true } : {}),
  };
  return applyDecorators(
    options.optional ? ApiPropertyOptional(doc) : ApiProperty(doc),
    ...(options.optional ? [IsOptional()] : []),
    trimString(),
    IsString(),
    Matches(MONEY_REQUEST, { message: `$property must be a decimal string with up to 2 decimals` }),
  );
}

/** A money response field: decimal string with exactly 2 decimals, THB. */
export function MoneyOutput(options: { example: string | null; description: string; nullable?: boolean }) {
  return ApiProperty({
    type: String,
    example: options.example,
    pattern: MONEY_RESPONSE,
    description: `${options.description} Unit: THB, decimal string (D-046).`,
    ...(options.nullable ? { nullable: true } : {}),
  });
}

/** A non-money decimal input (months, multiplier, register, m²) as a string. */
export function DecimalInput(options: {
  example: string;
  description: string;
  optional?: boolean;
  nullable?: boolean;
}) {
  const doc = {
    type: String,
    example: options.example,
    pattern: DECIMAL_REQUEST.source,
    description: `${options.description} Decimal string.`,
    ...(options.nullable ? { nullable: true } : {}),
  };
  return applyDecorators(
    options.optional ? ApiPropertyOptional(doc) : ApiProperty(doc),
    ...(options.optional ? [IsOptional()] : []),
    trimString(),
    IsString(),
    Matches(DECIMAL_REQUEST, { message: `$property must be a decimal string` }),
  );
}

/** Formats a Prisma Decimal (or null) as a money string. */
export const money = (d: { toFixed(n: number): string } | null | undefined): string | null =>
  d === null || d === undefined ? null : d.toFixed(2);
export const moneyReq = (d: { toFixed(n: number): string }): string => d.toFixed(2);
/** Formats a Prisma Decimal without trailing zeros beyond `places`. */
export const decimal = (
  d: { toFixed(n: number): string } | null | undefined,
  places: number,
): string | null => (d === null || d === undefined ? null : d.toFixed(places));
