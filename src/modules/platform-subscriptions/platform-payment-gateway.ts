import { AppConfig } from '@config/app-config';
import { CLOCK, type Clock } from '@core/clock/clock';
import { ProviderCredentialsService } from '@core/credentials/provider-credentials.service';
import { SettingsService } from '@core/settings/settings.service';
import {
  type Merchant,
  PAYMENT_PROVIDERS,
  type PaymentProviderRegistry,
  QR_PROVIDERS,
  type QrPaymentAdapter,
  type QrProvider,
} from '@integrations/payments/payment-provider.port';
import { Inject, Injectable, Logger } from '@nestjs/common';

/** `platform.payments.merchant` (D-042 model applied to Collective's own receivables, D-204; ⚖ O-008). */
export interface PlatformMerchantSetting {
  enabled: boolean;
  provider: string;
  merchantRef: string;
  accountName: string;
}

export interface PlatformMerchant {
  merchant: Merchant;
  adapter: QrPaymentAdapter;
}

/**
 * The platform's own payment adapter (B6.1): platform invoices are collected by Collective Group (Thailand) through
 * its own merchant account — the same `QrPaymentAdapter` ports as the tenants' (KBank / SCB / Opn), but the merchant
 * comes from the platform setting `platform.payments.merchant` and its credentials from `platform.provider_credential`
 * (tenant_id NULL, sealed with the platform field key — D-240). In fake mode the fake provider always answers; in
 * real mode the merchant must be enabled and its credentials present (otherwise invoices carry no QR and Finance
 * records transfers).
 */
@Injectable()
export class PlatformPaymentGateway {
  private readonly logger = new Logger(PlatformPaymentGateway.name);

  constructor(
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviderRegistry,
    private readonly credentialStore: ProviderCredentialsService,
    private readonly settings: SettingsService,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private isQrProvider(p: string): p is QrProvider {
    return (QR_PROVIDERS as readonly string[]).includes(p);
  }

  /** The platform merchant, or null when collection by QR is not configured (transfers only). */
  async merchant(): Promise<PlatformMerchant | null> {
    const s = await this.settings.valueAt<PlatformMerchantSetting>(
      'platform.payments.merchant',
      this.clock.now(),
    );
    if (!this.isQrProvider(s.provider)) return null;
    if (this.providers.mode === 'real' && !s.enabled) return null;
    const stored = await this.credentialStore.get(
      { tenantId: null, kind: 'payment', provider: s.provider, merchantRef: s.merchantRef },
      'payments.platform_merchant',
    );
    if (!stored && this.providers.mode === 'real') {
      this.logger.error(`no credentials for the platform ${s.provider} merchant`);
      return null;
    }
    const credentials: Record<string, string> = stored ?? {};
    return {
      merchant: { provider: s.provider, merchantRef: s.merchantRef, accountName: s.accountName, credentials },
      adapter: this.providers.adapter(s.provider),
    };
  }

  adapter(provider: QrProvider): QrPaymentAdapter {
    return this.providers.adapter(provider);
  }

  isProvider(p: string): p is QrProvider {
    return this.isQrProvider(p);
  }
}
