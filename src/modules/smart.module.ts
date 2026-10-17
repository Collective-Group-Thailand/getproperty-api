import { Global, Module } from '@nestjs/common';

import { IngestService } from './ingest/ingest.service';
import {
  AutoServiceRequestSubscriber,
  DeviceCommandSubscriber,
  GatewayConfigSubscriber,
  InspectionReadingsHook,
  LossRecomputeSubscriber,
  ReadingCandidateSubscriber,
} from './smart.subscribers';
import { DeviceCommandsService } from './smart-devices/commands.service';
import { DeviceFleetService } from './smart-devices/fleet.service';
import { GatewayConfigService } from './smart-devices/gateway-config.service';
import { DeviceInstallsService } from './smart-devices/installs.service';
import { OtaService } from './smart-devices/ota.service';
import { BILLED_UNITS, MeterReadingsBilledUnits } from './smart-health/billed-units.provider';
import { MeterHealthService } from './smart-health/meter-health.service';
import { UtilityLossService } from './smart-health/utility-loss.service';
import { IngestPipeline } from './smart-ingest/ingest-pipeline.service';
import { SeriesService } from './smart-ingest/series.service';
import { TelemetryMaintenanceService } from './smart-ingest/telemetry-maintenance.service';
import { MeterReadingsService } from './smart-readings/meter-readings.service';
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
  MeterReadingsService,
  ReadingRoundsService,
  MeterHealthService,
  UtilityLossService,
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
    { provide: BILLED_UNITS, useClass: MeterReadingsBilledUnits },
    ReadingCandidateSubscriber,
    GatewayConfigSubscriber,
    DeviceCommandSubscriber,
    LossRecomputeSubscriber,
    AutoServiceRequestSubscriber,
    InspectionReadingsHook,
  ],
  exports: [...SERVICES, BILLED_UNITS],
})
export class SmartModule {}
