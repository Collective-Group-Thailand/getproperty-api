import { InvalidationBus } from '@common/cache/invalidation-bus';
import { FieldEncryption } from '@common/crypto/field-encryption';
import { Global, Module } from '@nestjs/common';

/**
 * Cross-cutting platform services shared by the three processes. B1.3 adds the writers every state
 * change uses in its transaction (AuditService, DomainEvents/outbox, SettingsService, FeatureFlags,
 * TariffsService, DocumentNumbering); B1.1 ships the cache bus and the one field-encryption instance
 * (without `FIELD_ENCRYPTION_KEY` its key is per process — a second instance could not read what the
 * first sealed).
 */
@Global()
@Module({
  providers: [InvalidationBus, FieldEncryption],
  exports: [InvalidationBus, FieldEncryption],
})
export class PlatformCoreModule {}
