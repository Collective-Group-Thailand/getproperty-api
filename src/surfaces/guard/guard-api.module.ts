import { Module } from '@nestjs/common';

import { SURFACES } from '../surfaces';
import { systemPingController } from '../system-ping.controller';
import { GuardGateController } from './guard.controller';

/** `/v1/guard/*` (contract §2, J4.1): the gate tablet of a guard shift — visits, invite scans, stamps, event stream (D-315, D-320, D-327). */
@Module({
  controllers: [systemPingController(SURFACES.guard), GuardGateController],
})
export class GuardApiModule {}
