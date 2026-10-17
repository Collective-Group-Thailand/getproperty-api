import { FieldEncryption } from '@common/crypto/field-encryption';
import { AppConfig } from '@config/app-config';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';

import { EMAIL, type EmailPort } from './email/email.port';
import { FakeEmail } from './email/fake-email';
import { SesEmailAdapter } from './email/ses-email.adapter';
import { KEY_WRAP } from './kms/key-wrap.port';
import { LocalKeyWrap } from './kms/local-key-wrap';
import { FakeLineLogin } from './line/fake-line-login';
import { FakeLineMessaging } from './line/fake-line-messaging';
import { LineLoginAdapter } from './line/line-login.adapter';
import { LINE_LOGIN, type LineLoginPort } from './line/line-login.port';
import { LineMessagingAdapter } from './line/line-messaging.adapter';
import { LINE_MESSAGING, type LineMessagingPort } from './line/line-messaging.port';
import { FakeMqttClient } from './mqtt/fake-mqtt-client';
import { EmqxMqttClient } from './mqtt/mqtt-client';
import { MQTT_CLIENT, type MqttClientPort } from './mqtt/mqtt-client.port';
import { FakePdfRenderer } from './pdf/fake-pdf-renderer';
import { PDF_RENDERER, type PdfRendererPort } from './pdf/pdf-renderer.port';
import { PuppeteerPdfRenderer } from './pdf/puppeteer-pdf-renderer';
import { FakeObjectStorage } from './s3/fake-object-storage';
import { OBJECT_STORAGE, type ObjectStorage } from './s3/object-storage.port';
import { S3ObjectStorage } from './s3/s3-object-storage';
import { AwsSecretsProvider } from './secrets/aws-secrets.provider';
import { FakeSecretsProvider } from './secrets/fake-secrets.provider';
import { SECRETS_PROVIDER } from './secrets/secrets.port';
import { FakeSms } from './sms/fake-sms';
import { SMS, type SmsPort } from './sms/sms.port';
import { ThaiBulkSmsAdapter } from './sms/thaibulksms.adapter';
import { ClamAvAdapter } from './virus-scan/clamav.adapter';
import { FakeVirusScan } from './virus-scan/fake-virus-scan';
import { VIRUS_SCAN, type VirusScanPort } from './virus-scan/virus-scan.port';
import { FakeWebPush } from './web-push/fake-web-push';
import { VapidWebPushAdapter } from './web-push/vapid-web-push.adapter';
import { WEB_PUSH, type WebPushPort } from './web-push/web-push.port';

@Injectable()
class MqttShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(MQTT_CLIENT) private readonly mqtt: MqttClientPort,
    @Inject(PDF_RENDERER) private readonly pdf: PdfRendererPort,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.mqtt.end().catch(() => undefined);
    // the headless browser of the real PDF renderer
    if (this.pdf instanceof PuppeteerPdfRenderer) await this.pdf.close().catch(() => undefined);
  }
}

function required(config: AppConfig, key: Parameters<AppConfig['get']>[0]): string {
  const value = config.get(key);
  if (typeof value !== 'string' || value === '')
    throw new Error(`${key} is required when INTEGRATIONS_MODE=real`);
  return value;
}

/**
 * Binds each provider port to its real adapter or its in-memory fake (`INTEGRATIONS_MODE`; object storage may be
 * overridden by `OBJECT_STORAGE_MODE`; the MQTT broker follows `MQTT_MODE`/`DATA_STORES_MODE` because it is
 * infrastructure). Real adapters fail fast at start-up when their configuration is missing. B1.3 adds SMS OTP,
 * LINE Login, LINE Messaging, email (SES), web push (VAPID), virus scan (ClamAV) and the tenant-key wrap.
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
        config.useFakeMqtt
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
    {
      provide: PDF_RENDERER,
      inject: [AppConfig],
      useFactory: (config: AppConfig): PdfRendererPort =>
        config.useFakePdfRenderer
          ? new FakePdfRenderer()
          : new PuppeteerPdfRenderer({
              executablePath: required(config, 'PDF_CHROMIUM_EXECUTABLE'),
              timeoutMs: config.get('PDF_RENDER_TIMEOUT_MS'),
            }),
    },
    {
      provide: SMS,
      inject: [AppConfig],
      useFactory: (config: AppConfig): SmsPort =>
        config.useFakes
          ? new FakeSms()
          : new ThaiBulkSmsAdapter({
              baseUrl: required(config, 'SMS_API_URL'),
              apiKey: required(config, 'SMS_API_KEY'),
              apiSecret: required(config, 'SMS_API_SECRET'),
              sender: config.get('SMS_SENDER'),
            }),
    },
    {
      provide: LINE_LOGIN,
      inject: [AppConfig],
      useFactory: (config: AppConfig): LineLoginPort =>
        config.useFakes
          ? new FakeLineLogin()
          : new LineLoginAdapter(
              required(config, 'LINE_LOGIN_CHANNEL_IDS')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            ),
    },
    {
      provide: LINE_MESSAGING,
      inject: [AppConfig],
      useFactory: (config: AppConfig): LineMessagingPort =>
        config.useFakes
          ? new FakeLineMessaging()
          : new LineMessagingAdapter(required(config, 'LINE_MESSAGING_ACCESS_TOKEN')),
    },
    {
      provide: EMAIL,
      inject: [AppConfig],
      useFactory: (config: AppConfig): EmailPort =>
        config.useFakes
          ? new FakeEmail()
          : new SesEmailAdapter(
              { region: config.get('AWS_REGION'), endpoint: config.get('AWS_ENDPOINT_URL') },
              config.get('EMAIL_FROM'),
            ),
    },
    {
      provide: WEB_PUSH,
      inject: [AppConfig],
      useFactory: (config: AppConfig): WebPushPort =>
        config.useFakes
          ? new FakeWebPush()
          : new VapidWebPushAdapter(
              required(config, 'WEB_PUSH_VAPID_PUBLIC_KEY'),
              required(config, 'WEB_PUSH_VAPID_PRIVATE_KEY'),
              config.get('WEB_PUSH_SUBJECT'),
            ),
    },
    {
      provide: VIRUS_SCAN,
      inject: [AppConfig],
      useFactory: (config: AppConfig): VirusScanPort =>
        config.useFakes
          ? new FakeVirusScan()
          : new ClamAvAdapter(required(config, 'CLAMAV_HOST'), config.get('CLAMAV_PORT')),
    },
    FieldEncryption,
    {
      provide: KEY_WRAP,
      inject: [FieldEncryption],
      useFactory: (key: FieldEncryption) => new LocalKeyWrap(key),
    },
    MqttShutdown,
  ],
  exports: [
    OBJECT_STORAGE,
    PDF_RENDERER,
    SECRETS_PROVIDER,
    MQTT_CLIENT,
    SMS,
    LINE_LOGIN,
    LINE_MESSAGING,
    EMAIL,
    WEB_PUSH,
    VIRUS_SCAN,
    KEY_WRAP,
    FieldEncryption,
  ],
})
export class IntegrationsModule {}
