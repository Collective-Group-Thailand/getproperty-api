import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

import { KpiValuesDto } from '../admin/platform-business.dto';

export enum InsightMetricName {
  TimeToBillHours = 'time_to_bill_hours',
  InvoiceCorrectionRatePct = 'invoice_correction_rate_pct',
  OnTimePaymentPct = 'on_time_payment_pct',
  AutoReconciledPct = 'auto_reconciled_pct',
  PaidByQrPct = 'paid_by_qr_pct',
  ReminderEffectivenessPct = 'reminder_effectiveness_pct',
  LossPct = 'loss_pct',
  MeterUptimePct = 'meter_uptime_pct',
  Csat = 'csat',
  ComplianceScore = 'compliance_score',
  AboveCapAcknowledgedPct = 'above_cap_acknowledged_pct',
  ServiceRequestsViaLinePct = 'service_requests_via_line_pct',
}

export enum BenchmarkMetricName {
  LossPct = 'loss_pct',
  OnTimePaymentPct = 'on_time_payment_pct',
  RentPerM2 = 'rent_per_m2',
}

export class InsightsQuery {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 3,
    maximum: 24,
    default: 12,
    description: 'Months of series.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(24)
  months?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    example: FAKE.buildingId,
    description: 'Series of one building (the 90-day KPIs stay tenant-wide).',
  })
  @IsOptional()
  @IsUUID()
  building?: string;
}

export class InsightPointDto {
  @ApiProperty({ format: 'date', example: '2026-11-01', description: 'First day of the Bangkok month.' })
  month!: string;

  @ApiProperty({ type: String, nullable: true, example: '97.50', description: 'null = nothing measured.' })
  value!: string | null;

  @ApiProperty({ type: 'integer', example: 40, description: 'How many measurements the value stands on.' })
  count!: number;
}

export class InsightSeriesDto {
  @ApiProperty({ enum: InsightMetricName, enumName: 'InsightMetric', example: 'on_time_payment_pct' })
  metric!: InsightMetricName;

  @ApiProperty({ type: () => [InsightPointDto] })
  points!: InsightPointDto[];
}

export class BenchmarkItemDto {
  @ApiProperty({ enum: BenchmarkMetricName, enumName: 'BenchmarkMetric', example: 'on_time_payment_pct' })
  metric!: BenchmarkMetricName;

  @ApiProperty({
    example: 'type:apartment|size:20-49',
    description: 'The bucket: tenant type, type × size band, or province / district (rent per m²).',
  })
  bucketKey!: string;

  @ApiProperty({ type: 'integer', example: 7, description: 'Tenants in the bucket (never fewer than 5).' })
  k!: number;

  @ApiProperty({ example: '78.0000' })
  p25!: string;

  @ApiProperty({ example: '86.5000' })
  p50!: string;

  @ApiProperty({ example: '93.1000' })
  p75!: string;

  @ApiProperty({ format: 'date', example: FAKE.date })
  asOf!: string;

  @ApiProperty({ example: '91.2000', description: 'My own value over the last 90 days.' })
  mine!: string;
}

export class BenchmarksDto {
  @ApiProperty({
    example: true,
    description:
      'An Owner of my tenant consented to anonymised analytics (`analytics.anonymised`); otherwise none.',
  })
  optedIn!: boolean;

  @ApiProperty({ type: () => [BenchmarkItemDto] })
  items!: BenchmarkItemDto[];
}

export class InsightsDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ format: 'date', example: FAKE.date })
  asOf!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  buildingId!: string | null;

  @ApiProperty({ type: () => KpiValuesDto, description: 'The seven D-083 KPIs over the last 90 days.' })
  current!: KpiValuesDto;

  @ApiProperty({ type: () => [InsightSeriesDto] })
  series!: InsightSeriesDto[];

  @ApiProperty({ type: () => BenchmarksDto })
  benchmarks!: BenchmarksDto;
}
