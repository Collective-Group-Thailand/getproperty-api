import type { Config } from 'jest';

const swc: [string, Record<string, unknown>] = [
  '@swc/jest',
  {
    jsc: {
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
      target: 'es2023',
      keepClassNames: true,
    },
    module: { type: 'commonjs' },
    sourceMaps: 'inline',
  },
];

const shared = {
  transform: { '^.+\\.ts$': swc },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testEnvironment: 'node',
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  moduleNameMapper: {
    '^@common/(.*)$': '<rootDir>/src/common/$1',
    '^@config/(.*)$': '<rootDir>/src/config/$1',
    '^@database/(.*)$': '<rootDir>/src/database/$1',
    '^@platform/(.*)$': '<rootDir>/src/platform/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@integrations/(.*)$': '<rootDir>/src/integrations/$1',
    '^@generated/(.*)$': '<rootDir>/src/generated/$1',
    // The generated Prisma client (and ESM-style sources) import siblings as `./x.js`; resolve them to `./x.ts`.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};

const config: Config = {
  watchman: false,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/generated/**',
    '!src/main.ts',
    '!src/worker.ts',
    '!src/ingest.ts',
    '!src/instrument.ts',
  ],
  coverageDirectory: 'coverage',
  projects: [
    {
      ...shared,
      displayName: 'unit',
      testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/unit/**/*.spec.ts'],
    },
    {
      // `pnpm test:int` — real PostgreSQL 18 (EMBEDDED_PG=1 or INT_DATABASE_URL, scripts/run-int-tests.mjs):
      // the global setup migrates (asset-core + prisma/migrations) and seeds a template database.
      ...shared,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
      globalSetup: '<rootDir>/test/integration/global-setup.ts',
      globalTeardown: '<rootDir>/test/integration/global-teardown.ts',
      setupFilesAfterEnv: ['<rootDir>/test/support/container-timeout.ts'],
    },
    {
      ...shared,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
      globalSetup: '<rootDir>/test/e2e/global-setup.ts',
      globalTeardown: '<rootDir>/test/e2e/global-teardown.ts',
      setupFilesAfterEnv: ['<rootDir>/test/support/container-timeout.ts'],
    },
  ],
};

export default config;
