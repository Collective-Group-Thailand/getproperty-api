import { DatabaseService } from '@database/database.service';
import { REDIS, type RedisClient } from '@database/redis.module';
import { MQTT_CLIENT, type MqttClientPort } from '@integrations/mqtt/mqtt-client.port';
import { OBJECT_STORAGE, type ObjectStorage } from '@integrations/s3/object-storage.port';
import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';

const TIMEOUT_MS = 2_000;

/**
 * One probe per dependency (contract §2, ADR-0001). A fake dependency (`DATA_STORES_MODE=fake`,
 * fake object storage) reports `up` with `mode: 'fake'` without touching the network; a real one is
 * really probed: `SELECT 1` on the `pg` pool, Redis `PING`, S3 `HeadBucket`, the MQTT connected flag.
 */
@Injectable()
export class DependencyHealthIndicators {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly database: DatabaseService,
    @Inject(REDIS) private readonly redis: RedisClient,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MQTT_CLIENT) private readonly mqtt: MqttClientPort,
  ) {}

  database_() {
    const check = this.health.check('database');
    if (this.database.mode === 'fake') return check.up({ mode: 'fake' });
    return check
      .attempt(async () => {
        await this.database.ping();
        return { mode: 'real' };
      })
      .withTimeout(TIMEOUT_MS);
  }

  redisPing() {
    const check = this.health.check('redis');
    if (this.redis.storeMode === 'fake') return check.up({ mode: 'fake' });
    return check
      .attempt(async () => {
        await this.redis.ping();
        return { mode: 'real' };
      })
      .withTimeout(TIMEOUT_MS);
  }

  objectStorage() {
    const check = this.health.check('storage');
    if (this.storage.mode === 'fake') return check.up({ mode: 'fake' });
    return check
      .attempt(async ({ signal }) => {
        await this.storage.ping(signal);
        return { mode: 'real' };
      })
      .withTimeout(TIMEOUT_MS);
  }

  mqttBroker() {
    const check = this.health.check('mqtt');
    if (this.mqtt.mode === 'fake') return check.up({ mode: 'fake' });
    return this.mqtt.connected
      ? check.up({ mode: 'real' })
      : check.down({ mode: 'real', message: 'not connected' });
  }
}
