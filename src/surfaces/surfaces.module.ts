import { Module } from '@nestjs/common';

import { AdminApiModule } from './admin/admin-api.module';
import { AuthApiModule } from './auth/auth-api.module';
import { DeviceApiModule } from './device/device-api.module';
import { OwnerApiModule } from './owner/owner-api.module';
import { PublicApiModule } from './public/public-api.module';
import { ResidentApiModule } from './resident/resident-api.module';
import { StaffApiModule } from './staff/staff-api.module';
import { TechnicianApiModule } from './technician/technician-api.module';
import { WebhooksModule } from './webhooks/webhooks.module';

/** The nine HTTP surfaces (contract §2) in one import for the HTTP process. */
@Module({
  imports: [
    AuthApiModule,
    OwnerApiModule,
    StaffApiModule,
    ResidentApiModule,
    TechnicianApiModule,
    AdminApiModule,
    DeviceApiModule,
    WebhooksModule,
    PublicApiModule,
  ],
})
export class SurfacesModule {}
