import { InvalidationBus } from '@common/cache/invalidation-bus';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { AppConfig } from '@config/app-config';
import { BULLMQ_REDIS, type RedisClient } from '@database/redis.module';
import { TenantTx } from '@database/tenant-tx';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';

import { AiUsageService } from './ai-usage/ai-usage.service';
import {
  BuildingService,
  FloorService,
  PartyService,
  PropertyService,
  UnitService,
} from './asset/asset.services';
import { GrantService } from './asset/grant.service';
import { AuditService } from './audit/audit.service';
import { AuditQueryService } from './audit/audit-query.service';
import { PlatformBrand } from './brand/platform-brand.service';
import { BusinessCalendarService } from './calendar/business-calendar.service';
import { CLOCK, type Clock, SystemClock } from './clock/clock';
import { ComplianceAcknowledgementService } from './compliance/compliance-acknowledgement.service';
import { ComplianceGate } from './compliance/compliance-gate.service';
import { ComplianceRulesService } from './compliance/compliance-rules.service';
import { ComplianceScoreService } from './compliance/compliance-score.service';
import { ProviderCredentialsService } from './credentials/provider-credentials.service';
import { DeviceBootstrapService } from './devices/device-bootstrap.service';
import { DeviceCaService } from './devices/device-ca.service';
import { DeviceIdentityService } from './devices/device-identity.service';
import { DeviceRegistryService } from './devices/device-registry.service';
import { EmqxAuthService } from './devices/emqx-auth.service';
import { DocumentsService } from './documents/documents.service';
import { DocumentNumbering } from './documents/numbering.service';
import { DomainEvents } from './events/domain-events';
import { EventConsumer } from './events/event-consumer.service';
import { OutboxAdminService } from './events/outbox-admin.service';
import { OutboxRelay } from './events/outbox-relay.service';
import { EventSubscriberRegistry } from './events/subscribers';
import { FeatureFlagsService } from './feature-flags/feature-flags.service';
import { AuthService } from './identity/auth.service';
import { OtpService } from './identity/otp.service';
import { SessionService } from './identity/session.service';
import { SigningKeys } from './identity/signing-keys';
import { SubjectService } from './identity/subjects.service';
import { TokenService } from './identity/token.service';
import { NotificationService } from './notifications/notification.service';
import { NotificationDelivery } from './notifications/notification-delivery.service';
import { NotificationRoutesService } from './notifications/notification-routes.service';
import { NotificationTemplatesService } from './notifications/notification-templates.service';
import { TopicPreferencesService } from './notifications/topic-preferences.service';
import { ConsentService } from './privacy/consent.service';
import { DsrService } from './privacy/dsr.service';
import { RetentionService } from './privacy/retention.service';
import { BullmqQueue } from './queue/bullmq-queue';
import { FakeQueue } from './queue/fake-queue';
import { QUEUE, type QueuePort } from './queue/queue.port';
import { RealtimeHub } from './realtime/realtime.hub';
import { SettingsService } from './settings/settings.service';
import { SUBSCRIBERS } from './subscribers/subscribers';
import { AccessService } from './tenancy/access.service';
import { BankAccountService } from './tenancy/bank-account.service';
import { TenantDataKeys } from './tenancy/data-keys.service';
import { InvitationService } from './tenancy/invitation.service';
import { MembershipService } from './tenancy/membership.service';
import { PlatformUsersService } from './tenancy/platform-users.service';
import { SupportGrantService } from './tenancy/support-grant.service';
import { TenantService } from './tenancy/tenant.service';
import { UtilityTariffsService } from './utility-tariffs/utility-tariffs.service';
import { WorkflowService } from './workflow/workflow.service';
import { WorkflowTimers } from './workflow/workflow-timers.service';

@Injectable()
class QueueShutdown implements OnApplicationShutdown {
  constructor(@Inject(QUEUE) private readonly queue: QueuePort) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}

const SERVICES = [
  TenantTx,
  LookupHasher,
  InvalidationBus,
  AuditService,
  AuditQueryService,
  DomainEvents,
  EventSubscriberRegistry,
  OutboxRelay,
  EventConsumer,
  OutboxAdminService,
  SettingsService,
  PlatformBrand,
  FeatureFlagsService,
  BusinessCalendarService,
  WorkflowService,
  WorkflowTimers,
  SigningKeys,
  TokenService,
  SessionService,
  SubjectService,
  OtpService,
  AuthService,
  AccessService,
  InvitationService,
  MembershipService,
  SupportGrantService,
  TenantDataKeys,
  TenantService,
  BankAccountService,
  PlatformUsersService,
  PropertyService,
  BuildingService,
  FloorService,
  UnitService,
  PartyService,
  GrantService,
  UtilityTariffsService,
  ComplianceAcknowledgementService,
  ComplianceGate,
  ComplianceRulesService,
  ComplianceScoreService,
  DocumentNumbering,
  DeviceCaService,
  DeviceRegistryService,
  DeviceBootstrapService,
  DeviceIdentityService,
  EmqxAuthService,
  ProviderCredentialsService,
  DocumentsService,
  NotificationService,
  NotificationRoutesService,
  NotificationTemplatesService,
  TopicPreferencesService,
  AiUsageService,
  NotificationDelivery,
  RealtimeHub,
  ConsentService,
  DsrService,
  RetentionService,
  ...SUBSCRIBERS,
];

/**
 * The platform core shared by the three processes (master plan §4 `core/*`): identity, tenancy & RBAC, asset core
 * primitives, settings, feature flags, utility tariffs, compliance acknowledgements, workflow engine, events +
 * outbox, notifications, realtime, documents, audit and privacy. Global, so surfaces and later business modules
 * inject the services directly. The clock and the queue are tokens (fake clock / in-memory queue in tests).
 */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: QUEUE,
      inject: [AppConfig, CLOCK, BULLMQ_REDIS],
      useFactory: (config: AppConfig, clock: Clock, redis: RedisClient | null): QueuePort =>
        config.useFakeRedis || !redis ? new FakeQueue(clock) : new BullmqQueue(redis),
    },
    QueueShutdown,
    ...SERVICES,
  ],
  exports: [CLOCK, QUEUE, ...SERVICES],
})
export class CoreModule {}
