import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { Body, Controller, HttpCode, type INestApplication, Module, Post } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import request from 'supertest';

import { Public } from '../../src/common/auth/auth.decorators';
import { ApiSurface, SURFACES } from '../../src/surfaces/surfaces';
import { createE2eApp } from '../support/e2e-app';

class EchoDto {
  @ApiProperty({ example: 'hello' })
  @IsString()
  note!: string;
}

let calls = 0;

/** A throw-away irreversible operation, registered only in this suite, to drive the interceptor end to end. */
@ApiTags('owner.system')
@ApiSurface(SURFACES.owner)
@Controller('owner/idempotency-probe')
class ProbeController {
  @Post()
  @HttpCode(201)
  @Public()
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.system.probe',
    summary: 'probe',
    description: 'test only',
    implements: ['D-002'],
  })
  @ApiSuccess(201, { description: 'created', example: { note: 'hello', call: 1 } })
  @ApiStandardErrors('validation.failed')
  create(@Body() body: EchoDto) {
    calls += 1;
    return { note: body.note, call: calls };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('Idempotency-Key (e2e, in-memory store)', () => {
  let app: INestApplication;
  const key = '3b241101-e2bb-4255-8caf-4136c566a962';

  beforeAll(async () => {
    // The probe is mounted next to the real surfaces; docs are built from the whole app, so the
    // committed-contract comparison lives in foundation.e2e-spec.ts, not here.
    app = (await createE2eApp([ProbeModule])).app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires the header and validates it as a uuid', async () => {
    const missing = await request(app.getHttpServer())
      .post('/v1/owner/idempotency-probe')
      .send({ note: 'a' })
      .expect(400);
    expect(missing.body.code).toBe('idempotency.key_required');
    const invalid = await request(app.getHttpServer())
      .post('/v1/owner/idempotency-probe')
      .set('Idempotency-Key', 'nope')
      .send({ note: 'a' })
      .expect(400);
    expect(invalid.body.code).toBe('idempotency.key_invalid');
  });

  it('replays the original response for the same key and body, and refuses a different body', async () => {
    const first = await request(app.getHttpServer())
      .post('/v1/owner/idempotency-probe')
      .set('Idempotency-Key', key)
      .send({ note: 'hello' })
      .expect(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const replay = await request(app.getHttpServer())
      .post('/v1/owner/idempotency-probe')
      .set('Idempotency-Key', key)
      .send({ note: 'hello' })
      .expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const reused = await request(app.getHttpServer())
      .post('/v1/owner/idempotency-probe')
      .set('Idempotency-Key', key)
      .send({ note: 'different' })
      .expect(422);
    expect(reused.body.code).toBe('idempotency.key_reused');
  });

  it('a failed attempt releases the key', async () => {
    const failKey = '3b241101-e2bb-4255-8caf-4136c566a963';
    const failed = await request(app.getHttpServer())
      .post('/v1/owner/idempotency-probe')
      .set('Idempotency-Key', failKey)
      .send({ wrong: 1 })
      .expect(422);
    expect(failed.body.code).toBe('validation.failed');
    expect(failed.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'note', code: 'isString' })]),
    );
    await request(app.getHttpServer())
      .post('/v1/owner/idempotency-probe')
      .set('Idempotency-Key', failKey)
      .send({ note: 'retry' })
      .expect(201);
  });
});
