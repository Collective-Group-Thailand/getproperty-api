import { Module } from '@nestjs/common';

import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import {
  OperatorAuthController,
  PlatformAuthController,
  ProspectAuthController,
  ResidentAuthController,
  SessionsController,
  TechnicianAuthController,
} from './auth.controllers';
import { GuardAuthController } from './guard-auth.controller';

/** `/v1/auth/*` (contract §4): token issuance for every audience, refresh, logout, JWKS (B1.3). */
@Module({
  controllers: [
    systemPingController(SURFACES.auth),
    OperatorAuthController,
    ResidentAuthController,
    TechnicianAuthController,
    ProspectAuthController,
    PlatformAuthController,
    SessionsController,
    // J4.1 (D-320): gate tablets and guard PIN sign-in
    GuardAuthController,
  ],
})
export class AuthApiModule {}
