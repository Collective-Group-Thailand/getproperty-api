import { ApiProperty } from '@nestjs/swagger';

/**
 * One action the API offers this actor on this entity right now. Built from the same
 * state and permission checks as the action endpoint itself, so the web never infers an action from a status. The
 * endpoint still decides: a stale list gets the endpoint's problem response.
 */
export class NextActionDto {
  @ApiProperty({
    example: 'bill.issue',
    description:
      '`<entity>.<action>`; stable, machine-readable — the web maps it to a label and the endpoint',
  })
  key!: string;

  @ApiProperty({
    example: false,
    description: 'Cannot be undone: the web asks for a typed confirmation and sends an `Idempotency-Key`',
  })
  irreversible!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Set when the action is shown but blocked right now, with the reason (a message key)',
  })
  disabledReason!: string | null;
}
