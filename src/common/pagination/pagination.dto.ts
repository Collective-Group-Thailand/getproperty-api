import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const MAX_PER_PAGE = 100;
export const DEFAULT_PER_PAGE = 25;
export const DEFAULT_CURSOR_LIMIT = 50;

export enum SortOrder {
  Asc = 'asc',
  Desc = 'desc',
}

/** `?page=1&perPage=25&sort=createdAt&order=desc&q=...` (contract §3 "Lists"). Extend per endpoint with filters. */
export class PageQuery {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: MAX_PER_PAGE, default: DEFAULT_PER_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PER_PAGE)
  perPage: number = DEFAULT_PER_PAGE;

  @ApiPropertyOptional({
    example: 'createdAt',
    description: 'Sort field; each endpoint validates it against its own allow-list.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sort?: string;

  @ApiPropertyOptional({ enum: SortOrder, enumName: 'SortOrder', default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({ description: 'Free-text search' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

/** `?cursor=...&limit=50` for feeds and timelines. */
export class CursorQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: MAX_PER_PAGE, default: DEFAULT_CURSOR_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PER_PAGE)
  limit: number = DEFAULT_CURSOR_LIMIT;
}

export class PageMeta {
  @ApiProperty({ type: 'integer', example: 1 })
  page!: number;

  @ApiProperty({ type: 'integer', example: 25 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 1234 })
  total!: number;
}

export class CursorMeta {
  @ApiProperty({ type: String, nullable: true, example: 'eyJpZCI6IjEyMyJ9' })
  nextCursor!: string | null;
}

export interface Page<T> {
  data: T[];
  meta: PageMeta;
}

export interface CursorPage<T> {
  data: T[];
  meta: CursorMeta;
}
