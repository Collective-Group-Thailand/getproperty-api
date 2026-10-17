import { Module } from '@nestjs/common';

import { IngestSubscriber } from './ingest.subscriber';

/** MQTT ingest process wiring: the subscriber hands each message to the `IngestPipeline` (B3.2, `SmartModule`). */
@Module({
  providers: [IngestSubscriber],
})
export class IngestModule {}
