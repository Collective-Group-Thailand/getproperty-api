import { CLOCK, FakeClock } from '@core/clock/clock';
import { type FakeSms } from '@integrations/sms/fake-sms';
import { SMS } from '@integrations/sms/sms.port';
import { type INestApplication, Module } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { WorkerRunner } from '../../src/worker.runner';
import { type IntDatabase } from './int-db';

/** The worker's processors inside the HTTP test app: one in-memory queue, one fake clock (`tick()` drives them). */
@Module({ providers: [WorkerRunner] })
class InProcessWorkerModule {}

export interface IntApp {
  app: INestApplication;
  http: ReturnType<typeof request>;
  clock: FakeClock;
  worker: WorkerRunner;
  sms: FakeSms;
  close(): Promise<void>;
}

/**
 * The whole platform against a real PostgreSQL database (integration suite): HTTP surfaces + worker processors in
 * one process, PostgreSQL real (RLS through gp_app / gp_platform), Redis/BullMQ, MQTT and every provider faked, the
 * clock fake (starts at the wall clock so seeded `now()` rows are in force).
 */
export async function createIntApp(db: IntDatabase, env: Record<string, string> = {}): Promise<IntApp> {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    INTEGRATIONS_MODE: 'fake',
    DATA_STORES_MODE: 'real',
    REDIS_MODE: 'fake',
    MQTT_MODE: 'fake',
    DATABASE_URL: db.url,
    DATABASE_APP_ROLE: 'gp_app',
    DATABASE_PLATFORM_ROLE: 'gp_platform',
    LOG_LEVEL: process.env.INT_DEBUG ? 'error' : 'silent',
    S3_BUCKET: 'getproperty-test',
    THROTTLE_LIMIT: '100000',
    AUTH_THROTTLE_LIMIT: '100000',
    ...env,
  });
  const clock = new FakeClock(new Date());
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, InProcessWorkerModule] })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: process.env.INT_DEBUG ? ['error'] : false,
    abortOnError: false,
  });
  configureApp(app);
  await app.init();
  return {
    app,
    http: request(app.getHttpServer()),
    clock,
    worker: app.get(WorkerRunner),
    sms: app.get<FakeSms>(SMS),
    close: () => app.close(),
  };
}
