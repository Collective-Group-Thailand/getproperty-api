import { Module } from '@nestjs/common';

import { EmqxAuthController, InternalEmqxGuard } from './emqx-auth.controller';

/** `/internal/*` — docker-network-only endpoints for the platform's shared services (EMQX HTTP authn/authz, D-235). */
@Module({ controllers: [EmqxAuthController], providers: [InternalEmqxGuard] })
export class InternalApiModule {}
