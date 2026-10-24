import { ApiProperty } from '@nestjs/swagger';

export class StorageDayDto {
  @ApiProperty({ format: 'date', example: '2026-10-24' })
  day!: string;

  @ApiProperty({ example: '734003200', description: 'Counted bytes that day (decimal string).' })
  countedBytes!: string;
}

/** The owner's storage position (D-276): what is stored, the allowance and the last 30 daily snapshots. */
export class OwnerStorageDto {
  @ApiProperty({ format: 'date-time', example: '2026-10-25T09:00:00+07:00' })
  asOf!: string;

  @ApiProperty({
    example: false,
    description:
      'False while the platform has not set a free allowance for this tenant type: usage is shown, nothing is held.',
  })
  metered!: boolean;

  @ApiProperty({
    example: '734003200',
    description: 'Counted bytes: files + records × counted size (decimal string).',
  })
  usedBytes!: string;

  @ApiProperty({ example: '650000000', description: 'Bytes of the stored files (decimal string).' })
  fileBytes!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { invoice: 1203, receipt: 1150, meter_reading: 8800 },
    description: 'Stored records per counted type.',
  })
  records!: Record<string, number>;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '5368709120',
    description: 'Free allowance + packs (bytes).',
  })
  allowanceBytes!: string | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 13,
    description: 'Used / allowance, whole percent (floor).',
  })
  usedPercent!: number | null;

  @ApiProperty({
    enum: ['ok', 'warning', 'full', 'over'],
    enumName: 'StorageLevel',
    nullable: true,
    example: 'ok',
  })
  level!: 'ok' | 'warning' | 'full' | 'over' | null;

  @ApiProperty({ type: String, nullable: true, example: '5', description: 'Free allowance in GB (setting).' })
  freeGb!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'THB per GB-month above the allowance (setting); null = overage not sold.',
  })
  pricePerGbMonth!: string | null;

  @ApiProperty({ type: [StorageDayDto] })
  history!: StorageDayDto[];
}
