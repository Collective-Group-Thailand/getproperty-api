import { AppConfig } from '@config/app-config';
import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';

import { FakeMqttClient } from './mqtt/fake-mqtt-client';
import { EmqxMqttClient } from './mqtt/mqtt-client';
import { MQTT_CLIENT, type MqttClientPort } from './mqtt/mqtt-client.port';
import { FakeObjectStorage } from './s3/fake-object-storage';
import { OBJECT_STORAGE, type ObjectStorage } from './s3/object-storage.port';
import { S3ObjectStorage } from './s3/s3-object-storage';
import { AwsSecretsProvider } from './secrets/aws-secrets.provider';
import { FakeSecretsProvider } from './secrets/fake-secrets.provider';
import { SECRETS_PROVIDER } from './secrets/secrets.port';

@Injectable()
class MqttShutdown implements OnApplicationShutdown {
  constructor(@Inject(MQTT_CLIENT) private readonly mqtt: MqttClientPort) {}

  async onApplicationShutdown(): Promise<void> {
    await this.mqtt.end().catch(() => undefined);
  }
}

/**
 * Binds each provider port to its real adapter or its fake (`INTEGRATIONS_MODE`; the MQTT broker
 * follows `DATA_STORES_MODE` because it is infrastructure, like PostgreSQL and Redis).
 * New providers (SES, SMS OTP, LINE, payment QR, slip verify, OCR…) are added here by the
 * deliverable that needs them, each with an in-memory fake.
 */
@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [AppConfig],
      useFactory: (config: AppConfig): ObjectStorage =>
        config.useFakeObjectStorage
          ? new FakeObjectStorage()
          : new S3ObjectStorage({
              region: config.get('AWS_REGION'),
              bucket: config.get('S3_BUCKET'),
              endpoint: config.get('AWS_ENDPOINT_URL'),
              forcePathStyle: config.get('S3_FORCE_PATH_STYLE'),
              keyPrefix: config.get('S3_KEY_PREFIX') ?? '',
            }),
    },
    {
      provide: SECRETS_PROVIDER,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        config.useFakes
          ? new FakeSecretsProvider({}, { fake: 'true' })
          : new AwsSecretsProvider({
              region: config.get('AWS_REGION'),
              endpoint: config.get('AWS_ENDPOINT_URL'),
            }),
    },
    {
      provide: MQTT_CLIENT,
      inject: [AppConfig],
      useFactory: (config: AppConfig): MqttClientPort =>
        config.useFakeDataStores
          ? new FakeMqttClient()
          : new EmqxMqttClient({
              // MQTT_URL is validated as required in real mode (validate-env.ts).
              url: config.get('MQTT_URL')!,
              clientId: `${config.get('MQTT_CLIENT_ID_PREFIX')}-${process.pid}`,
              username: config.get('MQTT_USERNAME'),
              password: config.get('MQTT_PASSWORD'),
              tlsCaPath: config.get('MQTT_TLS_CA'),
              tlsCertPath: config.get('MQTT_TLS_CERT'),
              tlsKeyPath: config.get('MQTT_TLS_KEY'),
            }),
    },
    MqttShutdown,
  ],
  exports: [OBJECT_STORAGE, SECRETS_PROVIDER, MQTT_CLIENT],
})
export class IntegrationsModule {}
