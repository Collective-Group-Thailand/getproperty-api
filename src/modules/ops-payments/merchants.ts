import {
  type Merchant,
  PAYMENT_PROVIDERS,
  type PaymentProviderRegistry,
  QR_PROVIDERS,
  type QrPaymentAdapter,
  type QrProvider,
} from '@collective/integrations/payments/qr';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { ProviderCredentialsService } from '@core/credentials/provider-credentials.service';
import { FeatureFlagsService } from '@core/feature-flags/feature-flags.service';
import { merchantRefHash } from '@core/tenancy/bank-account.service';
import { TenantDataKeys } from '@core/tenancy/data-keys.service';
import { type Tx } from '@database/prisma.service';
import { type TenantBankAccount } from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';

export interface MerchantAccount {
  account: TenantBankAccount;
  merchant: Merchant;
  adapter: QrPaymentAdapter;
}

/**
 * The tenant's receiving account at its payment provider (D-042): the active bank account with a provider (one
 * limited to the invoice's building first, else the default), its merchant reference (sealed with the tenant key)
 * and the per-merchant credentials from `platform.provider_credential` (D-240). A real provider is used only where its feature flag is
 * on for the tenant (`payments.provider.<provider>`, O-001); fakes everywhere in fake mode.
 */
@Injectable()
export class MerchantResolver {
  private readonly logger = new Logger(MerchantResolver.name);

  constructor(
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviderRegistry,
    private readonly keys: TenantDataKeys,
    private readonly hasher: LookupHasher,
    private readonly flags: FeatureFlagsService,
    private readonly credentialStore: ProviderCredentialsService,
  ) {}

  private isQrProvider(p: string): p is QrProvider {
    return (QR_PROVIDERS as readonly string[]).includes(p);
  }

  private async open(tx: Tx, account: TenantBankAccount): Promise<MerchantAccount | null> {
    if (!this.isQrProvider(account.paymentProvider) || !account.providerMerchantRefEnc) return null;
    const provider = account.paymentProvider;
    if (
      this.providers.mode === 'real' &&
      !(await this.flags.isEnabled(`payments.provider.${provider}`, account.tenantId))
    )
      return null;
    // the tenant's data key is read through `app.tenant_id` (platform transactions of callbacks and residents
    // have none yet); in a tenant transaction it is already this tenant
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${account.tenantId}, true)`;
    const merchantRef = await this.keys.decrypt(
      tx,
      {
        tenantId: account.tenantId,
        table: 'platform.tenant_bank_account',
        column: 'provider_merchant_ref',
        rowId: account.id,
      },
      account.providerMerchantRefEnc,
    );
    // D-240: sealed in platform.provider_credential with the tenant key, the decrypt audited
    const stored = await this.credentialStore.get(
      { tenantId: account.tenantId, kind: 'payment', provider, merchantRef },
      'payments.merchant',
    );
    if (!stored && this.providers.mode === 'real') {
      this.logger.error(`no credentials for ${provider} merchant of tenant ${account.tenantId}`);
      return null;
    }
    const credentials: Record<string, string> = stored ?? {};
    return {
      account,
      merchant: { provider, merchantRef, accountName: account.accountName, credentials },
      adapter: this.providers.adapter(provider),
    };
  }

  /** The account that collects a building's invoices, or null (no provider: transfers and slips only). */
  async forBuilding(tx: Tx, tenantId: string, buildingId: string): Promise<MerchantAccount | null> {
    const accounts = await tx.tenantBankAccount.findMany({
      where: { tenantId, state: 'active', paymentProvider: { not: 'none' } },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    const chosen =
      accounts.find((a) => a.buildingIds.includes(buildingId)) ??
      accounts.find((a) => a.buildingIds.length === 0 && a.isDefault) ??
      accounts.find((a) => a.buildingIds.length === 0) ??
      null;
    return chosen ? this.open(tx, chosen) : null;
  }

  async byId(tx: Tx, bankAccountId: string): Promise<MerchantAccount | null> {
    const account = await tx.tenantBankAccount.findUnique({ where: { id: bankAccountId } });
    return account ? this.open(tx, account) : null;
  }

  /** The account a provider callback is for (lookup hash of the merchant reference). */
  async byMerchantRef(tx: Tx, provider: QrProvider, merchantRef: string): Promise<MerchantAccount | null> {
    const account = await tx.tenantBankAccount.findFirst({
      where: {
        paymentProvider: provider,
        providerMerchantRefHash: merchantRefHash(this.hasher, provider, merchantRef),
        // a replaced account still receives callbacks for the QR codes it issued
        state: { in: ['active', 'replaced'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    return account ? this.open(tx, account) : null;
  }

  adapter(provider: QrProvider): QrPaymentAdapter {
    return this.providers.adapter(provider);
  }
}
