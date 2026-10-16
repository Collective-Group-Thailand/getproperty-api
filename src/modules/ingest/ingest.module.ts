import { Module } from '@nestjs/common';

import { IngestService } from './ingest.service';
import { IngestSubscriber } from './ingest.subscriber';

/** MQTT ingest (B1.1: validate and log; B3.2: dedup, persistence, events). */
@Module({
  providers: [IngestService, IngestSubscriber],
  exports: [IngestService],
})
export class IngestModule {}
