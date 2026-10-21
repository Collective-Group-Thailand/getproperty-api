import { DataStoresMode, IntegrationsMode, NodeEnv } from './env.schema';
import { InvalidEnvironmentError, validateEnv } from './validate-env';

describe('validateEnv', () => {
  it('applies defaults: fake stores, fake integrations, port 3000, Thai-first API', () => {
    const env = validateEnv({});
    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.DATA_STORES_MODE).toBe(DataStoresMode.Fake);
    expect(env.INTEGRATIONS_MODE).toBe(IntegrationsMode.Fake);
    expect(env.PORT).toBe(3000);
    expect(env.MQTT_SHARED_GROUP).toBe('ingest');
    expect(env.S3_BUCKET).toBe('getproperty-dev');
  });

  it('coerces numbers and booleans from strings and treats empty strings as unset', () => {
    const env = validateEnv({
      PORT: '8080',
      LOG_PRETTY: 'yes',
      DOCS_ENABLED: '1',
      TRUST_PROXY: '2',
      SENTRY_DSN: '',
    });
    expect(env.PORT).toBe(8080);
    expect(env.LOG_PRETTY).toBe(true);
    expect(env.DOCS_ENABLED).toBe(true);
    expect(env.TRUST_PROXY).toBe(2);
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it('fails fast listing every invalid variable, naming the rule but never the value', () => {
    expect.assertions(5);
    try {
      validateEnv({ PORT: '99999', LOG_LEVEL: 'loud', DATABASE_URL: 'mysql://x', MQTT_URL: 'http://broker' });
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      const { problems, message } = error as InvalidEnvironmentError;
      expect(problems).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^PORT: failed "max"/),
          expect.stringMatching(/^LOG_LEVEL: failed "isIn"/),
          expect.stringMatching(/^DATABASE_URL: failed "matches"/),
          expect.stringMatching(/^MQTT_URL: failed "matches"/),
        ]),
      );
      expect(problems).toHaveLength(4);
      expect(message).not.toContain('mysql://x');
      expect(message).toContain('Invalid environment:');
    }
  });

  it('requires the store URLs when DATA_STORES_MODE=real', () => {
    expect(() => validateEnv({ DATA_STORES_MODE: 'real' })).toThrow(
      /DATABASE_URL: required when DATA_STORES_MODE=real/,
    );
    expect(() => validateEnv({ DATA_STORES_MODE: 'real' })).toThrow(/REDIS_URL: required/);
    expect(() => validateEnv({ DATA_STORES_MODE: 'real' })).toThrow(/MQTT_URL: required/);
    expect(() =>
      validateEnv({
        DATA_STORES_MODE: 'real',
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        REDIS_URL: 'redis://h:6379',
        MQTT_URL: 'mqtts://broker:8883',
      }),
    ).not.toThrow();
  });

  it('refuses fakes and localhost in production', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow(
      /INTEGRATIONS_MODE: must be "real"[\s\S]*DATA_STORES_MODE: must be "real"[\s\S]*FIELD_ENCRYPTION_KEY[\s\S]*PUBLIC_API_BASE_URL/,
    );
  });

  it('device-facing URLs: no WSS URL and no device origin by default; device origin is an origin (D-231)', () => {
    const env = validateEnv({});
    expect(env.MQTT_PUBLIC_WS_URL).toBeUndefined();
    expect(env.DEVICE_PUBLIC_BASE_URL).toBeUndefined();
    expect(validateEnv({ MQTT_PUBLIC_WS_URL: '' }).MQTT_PUBLIC_WS_URL).toBeUndefined();
    expect(
      validateEnv({ DEVICE_PUBLIC_BASE_URL: 'https://device.getproperty.co' }).DEVICE_PUBLIC_BASE_URL,
    ).toBe('https://device.getproperty.co');
    expect(() => validateEnv({ DEVICE_PUBLIC_BASE_URL: 'https://device.getproperty.co/' })).toThrow(
      /DEVICE_PUBLIC_BASE_URL/,
    );
    expect(() => validateEnv({ MQTT_PUBLIC_WS_URL: 'https://x/mqtt' })).toThrow(/MQTT_PUBLIC_WS_URL/);
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        MQTT_PUBLIC_WS_URL: 'ws://x/mqtt',
        DEVICE_PUBLIC_BASE_URL: 'http://d',
      }),
    ).toThrow(/MQTT_PUBLIC_WS_URL: wss:\/\/ only[\s\S]*DEVICE_PUBLIC_BASE_URL: https:\/\/ only/);
  });

  it('validates the docs CIDR allow-list and the shared group token', () => {
    expect(() => validateEnv({ DOCS_ALLOWED_CIDRS: '10.0.0.0/8, 203.0.113.7' })).not.toThrow();
    expect(() => validateEnv({ DOCS_ALLOWED_CIDRS: 'not-an-ip' })).toThrow(
      /DOCS_ALLOWED_CIDRS: failed "isCidrList"/,
    );
    expect(() => validateEnv({ MQTT_SHARED_GROUP: 'in gest' })).toThrow(/MQTT_SHARED_GROUP/);
  });

  it('PDF_RENDERER_MODE: fake | real | queue; queue needs a Valkey; never fake in production (D-236, D-242)', () => {
    expect(validateEnv({ PDF_RENDERER_MODE: 'queue', REDIS_URL: 'redis://v:6379/2' }).PDF_RENDERER_MODE).toBe(
      'queue',
    );
    expect(() => validateEnv({ PDF_RENDERER_MODE: 'chromium' })).toThrow(/PDF_RENDERER_MODE/);
    expect(() => validateEnv({ PDF_RENDERER_MODE: 'queue' })).toThrow(/PDF_RENDER_REDIS_URL/);
    expect(() => validateEnv({ NODE_ENV: 'production', PDF_RENDERER_MODE: 'fake' })).toThrow(
      /PDF_RENDERER_MODE: must be "real" or "queue"/,
    );
  });

  it('DATABASE_POOL_MAX is 1…15 (the per-process ceiling is enforced at start-up, T-5)', () => {
    expect(validateEnv({ DATABASE_POOL_MAX: '12' }).DATABASE_POOL_MAX).toBe(12);
    expect(() => validateEnv({ DATABASE_POOL_MAX: '40' })).toThrow(/DATABASE_POOL_MAX/);
  });
});
