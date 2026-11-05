import { Global, Module } from '@nestjs/common';

import { IngestService } from './ingest/ingest.service';
import { InvoiceBilledUnits } from './ops-billing/invoice-billed-units';
import {
  DeviceCommandSubscriber,
  GatewayConfigSubscriber,
  InspectionReadingsHook,
  LossRecomputeSubscriber,
  ReadingCandidateSubscriber,
} from './smart.subscribers';
import { AccessLifecycle, AccessNotifications, AccessVendorSync } from './smart-access/access.subscribers';
import { AccessCredentialsService } from './smart-access/access-credentials.service';
import { AccessViewsService } from './smart-access/access-views.service';
import { LocksService } from './smart-access/locks.service';
import { DeviceCommandsService } from './smart-devices/commands.service';
import { DeviceFleetService } from './smart-devices/fleet.service';
import { GatewayConfigService } from './smart-devices/gateway-config.service';
import { DeviceInstallsService } from './smart-devices/installs.service';
import { OtaService } from './smart-devices/ota.service';
import { StaffFieldService } from './smart-devices/staff-field.service';
import { GateNotifications } from './smart-gate/gate.subscribers';
import { GateAdminService } from './smart-gate/gate-admin.service';
import { GateRetentionService } from './smart-gate/gate-retention.service';
import { GuardAuthService } from './smart-gate/guard-auth.service';
import { VisitsService } from './smart-gate/visits.service';
import { BILLED_UNITS } from './smart-health/billed-units.provider';
import { LossReportExportBuilder } from './smart-health/loss-report-export.builder';
import { MeterHealthService } from './smart-health/meter-health.service';
import { UtilityLossService } from './smart-health/utility-loss.service';
import { IngestPipeline } from './smart-ingest/ingest-pipeline.service';
import { SeriesService } from './smart-ingest/series.service';
import { TelemetryMaintenanceService } from './smart-ingest/telemetry-maintenance.service';
import { MeterReadingsService } from './smart-readings/meter-readings.service';
import { ReadingRequestsService } from './smart-readings/reading-requests.service';
import { ReadingRoundsService } from './smart-readings/reading-rounds.service';

const SERVICES = [
  IngestService,
  IngestPipeline,
  TelemetryMaintenanceService,
  SeriesService,
  DeviceFleetService,
  DeviceInstallsService,
  GatewayConfigService,
  DeviceCommandsService,
  OtaService,
  StaffFieldService,
  MeterReadingsService,
  ReadingRoundsService,
  ReadingRequestsService,
  MeterHealthService,
  UtilityLossService,
  AccessCredentialsService,
  LocksService,
  AccessViewsService,
  // J4.1 gate & visitor (D-315, D-327)
  GuardAuthService,
  VisitsService,
  GateAdminService,
  GateRetentionService,
];

/**
 * Group A smart metering (B3): device registry, provisioning and installs, gateway config, commands and OTA (3.1),
 * ingest pipeline, telemetry partitions and rollups (3.2), meter readings and rounds (3.3), meter health, utility
 * invoices and loss (3.4). Shared by the HTTP, worker and ingest processes; subscribers consume in the worker.
 */
@Global()
@Module({
  providers: [
    ...SERVICES,
    // B4.2: billed units of the loss report come from issued invoices (the B3.4 readings stub is gone, D-032)
    { provide: BILLED_UNITS, useClass: InvoiceBilledUnits },
    AccessLifecycle,
    AccessVendorSync,
    AccessNotifications,
    ReadingCandidateSubscriber,
    GatewayConfigSubscriber,
    DeviceCommandSubscriber,
    LossRecomputeSubscriber,
    InspectionReadingsHook,
    LossReportExportBuilder,
    GateNotifications,
  ],
  exports: [...SERVICES, BILLED_UNITS],
})
export class SmartModule {}
