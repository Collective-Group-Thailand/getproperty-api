import { DatabaseService } from '@database/database.service';
import { REDIS, type RedisClient } from '@database/redis.module';
import { MQTT_CLIENT, type MqttClientPort } from '@integrations/mqtt/mqtt-client.port';
import { type INestApplicationContext } from '@nestjs/common';

import { type OpsCheck } from './metrics';

/**
 * The `/health` checks of the worker and ingest processes (D-230): PostgreSQL `SELECT 1`, Redis `PING` and — for
 * ingest — the MQTT connection. A dependency running as an in-memory fake counts as up, as on the API's `/health`.
 */
export function processChecks(app: INestApplicationContext, options: { mqtt: boolean }): () => OpsCheck[] {
  const database = app.get(DatabaseService);
  const redis = app.get<RedisClient>(REDIS);
  const mqtt = options.mqtt ? app.get<MqttClientPort>(MQTT_CLIENT) : undefined;
  return () => [
    {
      name: 'database',
      probe: async () => {
        if (database.mode !== 'fake') await database.ping();
      },
    },
    {
      name: 'redis',
      probe: async () => {
        if (redis.storeMode !== 'fake') await redis.ping();
      },
    },
    ...(mqtt
      ? [
          {
            name: 'mqtt',
            probe: () =>
              mqtt.mode === 'fake' || mqtt.connected
                ? Promise.resolve()
                : Promise.reject(new Error('not connected')),
          },
        ]
      : []),
  ];
}
