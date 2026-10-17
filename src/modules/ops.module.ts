import { Global, Module } from '@nestjs/common';

import { PartiesService } from './ops-parties/parties.service';
import { ResidentPrivacyService } from './ops-parties/resident-privacy.service';
import { BoardService } from './ops-units/board.service';
import { AmenitiesService, MetersService } from './ops-units/meters-items.service';
import { UnitProfilesService, UtilityAccountsService } from './ops-units/profiles-accounts.service';
import { StructureService } from './ops-units/structure.service';
import { UnitImportService } from './ops-units/unit-import.service';
import { UnitsService } from './ops-units/units.service';

const SERVICES = [
  StructureService,
  UnitsService,
  UnitProfilesService,
  UtilityAccountsService,
  MetersService,
  AmenitiesService,
  BoardService,
  UnitImportService,
  PartiesService,
  ResidentPrivacyService,
];

/**
 * Group A business modules (master plan §4: `modules/ops-*`), shared by the HTTP and worker processes so their
 * event subscribers run in the worker. B2: units (2.1), parties (2.2), leases (2.3), deposits & inspections (2.4).
 */
@Global()
@Module({ providers: SERVICES, exports: SERVICES })
export class OpsModule {}
