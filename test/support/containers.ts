import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/** Same images as docker-compose.yml and production (ADR-0001). */
export const POSTGRES_IMAGE = 'timescale/timescaledb-ha:pg18';
export const REDIS_IMAGE = 'redis:7-alpine';
export const EMQX_IMAGE = 'emqx/emqx:5.8';

export interface TestInfra {
  postgres: StartedPostgreSqlContainer;
  redis: StartedRedisContainer;
  emqx: StartedTestContainer;
  env: Record<string, string>;
}

/** The environment every test process uses when the stores are in-memory fakes (no Docker). */
export const FAKE_TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  INTEGRATIONS_MODE: 'fake',
  DATA_STORES_MODE: 'fake',
  LOG_LEVEL: 'silent',
  S3_BUCKET: 'getproperty-test',
  THROTTLE_LIMIT: '100000',
};

/** `DATA_STORES_MODE=real` runs the suites against Testcontainers; anything else uses the fakes. */
export function realDataStoresRequested(): boolean {
  return process.env.DATA_STORES_MODE === 'real';
}

/**
 * Docker Desktop (macOS) serves its socket at ~/.docker/run/docker.sock and only symlinks
 * /var/run/docker.sock when "Allow the default Docker socket" is on. Point Testcontainers at it
 * when DOCKER_HOST is not set; Ryuk still mounts the in-VM path. CI runners are unaffected.
 */
export function ensureDockerHost(): void {
  if (process.env.DOCKER_HOST || existsSync('/var/run/docker.sock')) return;
  const desktopSocket = join(homedir(), '.docker', 'run', 'docker.sock');
  if (!existsSync(desktopSocket)) return;
  process.env.DOCKER_HOST = `unix://${desktopSocket}`;
  process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= '/var/run/docker.sock';
}

export async function startTestInfra(): Promise<TestInfra> {
  ensureDockerHost();
  const [postgres, redis, emqx] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).withDatabase('getproperty_test').start(),
    new RedisContainer(REDIS_IMAGE).start(),
    new GenericContainer(EMQX_IMAGE)
      .withExposedPorts(1883)
      .withEnvironment({ EMQX_ALLOW_ANONYMOUS: 'true', EMQX_AUTHORIZATION__NO_MATCH: 'allow' })
      .withWaitStrategy(Wait.forLogMessage(/EMQX .* is running now/))
      .start(),
  ]);
  return {
    postgres,
    redis,
    emqx,
    env: {
      ...FAKE_TEST_ENV,
      DATA_STORES_MODE: 'real',
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: redis.getConnectionUrl(),
      MQTT_URL: `mqtt://${emqx.getHost()}:${emqx.getMappedPort(1883)}`,
    },
  };
}

/** Tolerates containers a test already stopped. */
export async function stopTestInfra(infra: TestInfra | undefined): Promise<void> {
  await Promise.allSettled([infra?.postgres.stop(), infra?.redis.stop(), infra?.emqx.stop()]);
}
