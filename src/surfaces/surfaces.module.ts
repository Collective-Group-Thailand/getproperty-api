import { Module } from '@nestjs/common';

import { AdminApiModule } from './admin/admin-api.module';
import { AuthApiModule } from './auth/auth-api.module';
import { DeviceApiModule } from './device/device-api.module';
import { OwnerApiModule } from './owner/owner-api.module';
import { StaffApiModule } from './staff/staff-api.module';
import { TenantApiModule } from './tenant/tenant-api.module';
import { WebhooksModule } from './webhooks/webhooks.module';

/** The seven HTTP surfaces (contract §2) in one import for the HTTP process. */
@Module({
  imports: [
    AuthApiModule,
    OwnerApiModule,
    TenantApiModule,
    StaffApiModule,
    AdminApiModule,
    DeviceApiModule,
    WebhooksModule,
  ],
})
export class SurfacesModule {}
