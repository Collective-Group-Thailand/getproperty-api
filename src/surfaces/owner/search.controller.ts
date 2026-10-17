import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { SearchService } from '@modules/ops-units/search.service';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

import { ApiSurface, SURFACES } from '../surfaces';

export enum SearchHitTypeName {
  Building = 'building',
  Unit = 'unit',
  Party = 'party',
  Lease = 'lease',
  Device = 'device',
  Invoice = 'invoice',
}

export class SearchQuery {
  @ApiProperty({ example: 'A-20', description: 'At least 2 characters; matches names, numbers and serials.' })
  @IsString()
  @Length(2, 100)
  q!: string;
}

export class SearchHitDto {
  @ApiProperty({ enum: SearchHitTypeName, enumName: 'SearchHitType', example: SearchHitTypeName.Unit })
  type!: SearchHitTypeName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: FAKE.unitCode })
  label!: string;

  @ApiProperty({ type: String, nullable: true, example: 'อาคาร A' })
  sublabel!: string | null;
}

export class SearchResultDto {
  @ApiProperty({ type: () => [SearchHitDto] })
  data!: SearchHitDto[];
}

@ApiTags('owner.search')
@ApiSurface(SURFACES.owner)
@Controller('owner/search')
export class OwnerSearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @TenantScoped()
  @Can('property.read')
  @ApiEndpoint({
    id: 'owner.search.query',
    summary: 'Global search of the owner console',
    description:
      'Buildings, units, parties (display name only), leases, devices and invoices (by number) of the current tenant matching `q` (≥ 2 characters, case-insensitive), at most 20 hits with prefix matches first; Staff limited to buildings see those buildings only, a cross-tenant row never appears (D-152).',
    implements: ['D-152', 'D-151'],
  })
  @ApiSuccess(200, {
    description: 'Hits',
    type: SearchResultDto,
    example: {
      data: [
        { type: 'unit', id: FAKE.uuid, label: FAKE.unitCode, sublabel: 'อาคาร A' },
        { type: 'lease', id: FAKE.uuid, label: 'CTR-2026-00001', sublabel: FAKE.unitCode },
      ],
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'tenant.context_required',
    'tenant.context_invalid',
    'tenant.not_in_scope',
  )
  async query(@CurrentTenant() ctx: TenantContext, @Query() q: SearchQuery): Promise<SearchResultDto> {
    const hits = await this.search.search(ctx, q.q);
    return { data: hits.map((h) => ({ ...h, type: h.type as SearchHitTypeName })) };
  }
}
