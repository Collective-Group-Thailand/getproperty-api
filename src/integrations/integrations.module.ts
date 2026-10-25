import { setIntegrationsLogger } from '@collective/integrations';
import {
  AI_GATEWAY,
  type AiGatewayPort,
  FakeAiGateway,
  HttpAiGatewayAdapter,
  UnconfiguredAiGateway,
} from '@collective/integrations/ai';
import { ETAX_PROVIDERS, FakeEtaxProviders, RealEtaxProviders } from '@collective/integrations/etax';
import {
  FakeFirebaseVerifier,
  FIREBASE_VERIFIER,
  type FirebaseVerifier,
  JoseFirebaseVerifier,
} from '@collective/integrations/identity';
import {
  FakeLineLogin,
  FakeLineMessaging,
  LINE_LOGIN,
  LINE_MESSAGING,
  LineLoginAdapter,
  type LineLoginPort,
  LineMessagingAdapter,
  type LineMessagingPort,
} from '@collective/integrations/line';
import { FakeOcr, OCR, type OcrPort, VisionOcrAdapter } from '@collective/integrations/ocr';
import {
  EasySlipVerifier,
  FakePaymentProviders,
  FakeSlipVerifier,
  PAYMENT_PROVIDERS,
  RealPaymentProviders,
  SLIP_VERIFIER,
} from '@collective/integrations/payments/qr';
import { AwsSecretsProvider, FakeSecretsProvider, SECRETS_PROVIDER } from '@collective/integrations/secrets';
import {
  FakeObjectStorage,
  OBJECT_STORAGE,
  type ObjectStorage,
  S3ObjectStorage,
} from '@collective/integrations/storage';
import { FieldEncryption } from '@common/crypto/field-encryption';
import { AppConfig } from '@config/app-config';
import { Global, Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';

import { EMAIL, type EmailPort } from './email/email.port';
import { FakeEmail } from './email/fake-email';
import { SesEmailAdapter } from './email/ses-email.adapter';
import { KEY_WRAP } from './kms/key-wrap.port';
import { LocalKeyWrap } from './kms/local-key-wrap';
import { FakeLockVendors } from './locks/fake-lock-vendors';
import { LOCK_VENDORS } from './locks/lock-vendor.port';
import { RealLockVendors } from './locks/real-lock-vendors';
import { FakeMqttClient } from './mqtt/fake-mqtt-client';
import { EmqxMqttClient } from './mqtt/mqtt-client';
import { MQTT_CLIENT, type MqttClientPort } from './mqtt/mqtt-client.port';
import { FakePdfRenderer } from './pdf/fake-pdf-renderer';
import { PDF_RENDERER, type PdfRendererPort } from './pdf/pdf-renderer.port';
import { PuppeteerPdfRenderer } from './pdf/puppeteer-pdf-renderer';
import { BullmqPdfRenderTransport, QueuePdfRenderer } from './pdf/queue-pdf-renderer';
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
    if (this.pdf instanceof PuppeteerPdfRenderer || this.pdf instanceof QueuePdfRenderer)
      await this.pdf.close().catch(() => undefined);
  }
}

function required(config: AppConfig, key: Parameters<AppConfig['get']>[0]): string {
  const value = config.get(key);
  if (typeof value !== 'string' || value === '')
    throw new Error(`${key} is required when INTEGRATIONS_MODE=real`);
  return value;
}

/**
 * Provider ports and adapters come from `@collective/integrations` (D-275, D-278) except the product-specific ones
 * (kms, locks, mqtt, integration webhooks, the PDF renderers, web push and virus scan — see D-278); SMS and e-mail keep
 * getproperty's port shape over the shared senders.
 * Binds each provider port to its real adapter or its in-memory fake (`INTEGRATIONS_MODE`; object storage may be
 * overridden by `OBJECT_STORAGE_MODE`; the MQTT broker follows `MQTT_MODE`/`DATA_STORES_MODE` because it is
 * infrastructure). Real adapters fail fast at start-up when their configuration is missing. B1.3 adds SMS OTP,
 * LINE Login, LINE Messaging, email (SES), web push (VAPID), virus scan (ClamAV) and the tenant-key wrap.
 * The production runtime is AWS like getpack (D-230): object storage = S3, secrets = Secrets Manager, email = SES, with
 * the ECS task role's credentials (never keys in env) and LocalStack in development (`docker compose up -d`).
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
              protocolVersion: config.get('MQTT_PROTOCOL_VERSION'),
            }),
    },
    {
      provide: AI_GATEWAY,
      inject: [AppConfig],
      useFactory: (config: AppConfig): AiGatewayPort => {
        if (config.useFakes) return new FakeAiGateway();
        const url = config.get('AI_GATEWAY_URL');
        const key = config.get('AI_GATEWAY_API_KEY');
        return url && key
          ? new HttpAiGatewayAdapter({
              baseUrl: url,
              apiKey: key,
              model: config.get('AI_VISION_MODEL'),
              timeoutMs: config.get('AI_GATEWAY_TIMEOUT_MS'),
            })
          : new UnconfiguredAiGateway();
      },
    },
    {
      provide: OCR,
      inject: [AppConfig, AI_GATEWAY],
      useFactory: (config: AppConfig, ai: AiGatewayPort): OcrPort =>
        config.useFakes ? new FakeOcr() : new VisionOcrAdapter(ai),
    },
    {
      provide: PAYMENT_PROVIDERS,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        config.useFakes
          ? new FakePaymentProviders()
          : new RealPaymentProviders({
              kbank: config.get('PAYMENTS_KBANK_BASE_URL'),
              scb: config.get('PAYMENTS_SCB_BASE_URL'),
              opn: config.get('PAYMENTS_OPN_BASE_URL'),
            }),
    },
    {
      provide: LOCK_VENDORS,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        config.useFakes
          ? new FakeLockVendors()
          : new RealLockVendors({
              ttlock: config.get('LOCKS_TTLOCK_BASE_URL'),
              tuya: config.get('LOCKS_TUYA_BASE_URL'),
            }),
    },
    {
      provide: ETAX_PROVIDERS,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        config.useFakes
          ? new FakeEtaxProviders()
          : new RealEtaxProviders({ inet: config.get('ETAX_INET_BASE_URL') }),
    },
    {
      provide: SLIP_VERIFIER,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => {
        const key = config.get('SLIP_VERIFY_API_KEY');
        return config.useFakes || !key
          ? new FakeSlipVerifier()
          : new EasySlipVerifier(config.get('SLIP_VERIFY_BASE_URL'), key);
      },
    },
    {
      // D-236 / D-242 (ADR-0012): `queue` = the shared pdf-render queue (getpack's Chromium), `real` = own Chromium
      provide: PDF_RENDERER,
      inject: [AppConfig, OBJECT_STORAGE],
      useFactory: (config: AppConfig, storage: ObjectStorage): PdfRendererPort => {
        const mode = config.pdfRendererMode;
        if (mode === 'fake') return new FakePdfRenderer();
        if (mode === 'queue')
          return new QueuePdfRenderer(
            new BullmqPdfRenderTransport(
              (config.get('PDF_RENDER_REDIS_URL') ?? config.get('REDIS_URL'))!,
              config.get('PDF_RENDER_QUEUE_PREFIX'),
            ),
            storage,
            {
              bucket: config.get('S3_BUCKET'),
              keyPrefix: config.get('S3_KEY_PREFIX') ?? '',
              product: 'getproperty',
              renderTimeoutMs: config.get('PDF_RENDER_TIMEOUT_MS'),
              waitTimeoutMs: config.get('PDF_RENDER_QUEUE_TIMEOUT_MS'),
            },
          );
        return new PuppeteerPdfRenderer({
          executablePath: required(config, 'PDF_CHROMIUM_EXECUTABLE'),
          timeoutMs: config.get('PDF_RENDER_TIMEOUT_MS'),
        });
      },
    },
    {
      provide: SMS,
      inject: [AppConfig],
      useFactory: (config: AppConfig): SmsPort =>
        config.useFakes
          ? new FakeSms()
          : new ThaiBulkSmsAdapter({
              apiKey: required(config, 'SMS_API_KEY'),
              apiSecret: required(config, 'SMS_API_SECRET'),
              sender: config.get('SMS_SENDER'),
              creditType: config.get('SMS_CREDIT_TYPE'),
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
      // D-255: Google / Apple sign-in through Firebase ID tokens, verified locally against Google's keys
      provide: FIREBASE_VERIFIER,
      inject: [AppConfig],
      useFactory: (config: AppConfig): FirebaseVerifier =>
        config.useFakes
          ? new FakeFirebaseVerifier()
          : new JoseFirebaseVerifier(config.get('FIREBASE_PROJECT_ID')),
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
              config.get('SES_FROM_ADDRESS'),
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
    PAYMENT_PROVIDERS,
    LOCK_VENDORS,
    ETAX_PROVIDERS,
    SLIP_VERIFIER,
    PDF_RENDERER,
    SECRETS_PROVIDER,
    MQTT_CLIENT,
    AI_GATEWAY,
    OCR,
    SMS,
    LINE_LOGIN,
    LINE_MESSAGING,
    FIREBASE_VERIFIER,
    EMAIL,
    WEB_PUSH,
    VIRUS_SCAN,
    KEY_WRAP,
    FieldEncryption,
  ],
})
export class IntegrationsModule {
  constructor() {
    // The shared adapters (@collective/integrations, D-275) log through Nest's logger (pino in main/worker/ingest).
    setIntegrationsLogger(new Logger('Integrations'));
  }
}
