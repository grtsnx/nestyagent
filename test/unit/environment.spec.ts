import { describe, expect, it } from 'vitest';
import { validateEnvironment } from '@/config/environment.js';

describe('validateEnvironment', () => {
  it('uses secure, stateless defaults', () => {
    expect(validateEnvironment({})).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      PLATFORM_NAME: 'Agentic',
      CORS_ORIGINS: [],
      OBSERVE_ENABLED: false,
      SWAGGER_ENABLED: true,
      TRACE_PAYLOADS: false,
    });
  });

  it('keeps a trimmed account password and treats a blank value as unset', () => {
    expect(
      validateEnvironment({ ACCOUNT_PASSWORD: '  secret  ' }).ACCOUNT_PASSWORD,
    ).toBe('secret');
    expect(
      validateEnvironment({ ACCOUNT_PASSWORD: '' }).ACCOUNT_PASSWORD,
    ).toBeUndefined();
  });

  it('keeps a trimmed executor key and treats a blank value as unset', () => {
    expect(
      validateEnvironment({ OPENAI_EXECUTOR_API_KEY: '  ek-test  ' })
        .OPENAI_EXECUTOR_API_KEY,
    ).toBe('ek-test');
    expect(
      validateEnvironment({ OPENAI_EXECUTOR_API_KEY: '' })
        .OPENAI_EXECUTOR_API_KEY,
    ).toBeUndefined();
  });

  it('keeps a trimmed webhook secret and treats a blank value as unset', () => {
    expect(
      validateEnvironment({ OPENAI_WEBHOOK_SECRET: '  whsec_test  ' })
        .OPENAI_WEBHOOK_SECRET,
    ).toBe('whsec_test');
    expect(
      validateEnvironment({ OPENAI_WEBHOOK_SECRET: '' }).OPENAI_WEBHOOK_SECRET,
    ).toBeUndefined();
  });
  it('keeps a trimmed OpenAI API key and treats a blank value as unset', () => {
    expect(
      validateEnvironment({ OPENAI_API_KEY: '  sk-test  ' }).OPENAI_API_KEY,
    ).toBe('sk-test');
    expect(
      validateEnvironment({ OPENAI_API_KEY: '' }).OPENAI_API_KEY,
    ).toBeUndefined();
  });

  it('normalizes and deduplicates CORS origins', () => {
    const environment = validateEnvironment({
      CORS_ORIGINS:
        'https://app.example.com, https://admin.example.com,https://app.example.com',
    });

    expect(environment.CORS_ORIGINS).toEqual([
      'https://app.example.com',
      'https://admin.example.com',
    ]);
  });

  it('rejects wildcard and path-based CORS origins', () => {
    expect(() => validateEnvironment({ CORS_ORIGINS: '*' })).toThrow(
      /CORS_ORIGINS/,
    );
    expect(() =>
      validateEnvironment({ CORS_ORIGINS: 'https://example.com/app' }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it('disables Swagger by default in production', () => {
    expect(
      validateEnvironment({ NODE_ENV: 'production' }).SWAGGER_ENABLED,
    ).toBe(false);
  });

  it('rejects invalid ports and booleans', () => {
    expect(() => validateEnvironment({ PORT: '0' })).toThrow(/PORT/);
    expect(() => validateEnvironment({ OBSERVE_ENABLED: 'sometimes' })).toThrow(
      /OBSERVE_ENABLED/,
    );
  });

  it('requires complete observability credentials when enabled', () => {
    expect(() => validateEnvironment({ OBSERVE_ENABLED: 'true' })).toThrow(
      /OBSERVE_APP_KEY/,
    );

    expect(
      validateEnvironment({
        OBSERVE_ENABLED: 'true',
        OBSERVE_APP_KEY: 'key',
        OBSERVE_APP_SECRET: 'secret',
        OBSERVE_SERVICE_ID: 'service',
      }).OBSERVE_ENABLED,
    ).toBe(true);
  });

  it('requires the full Langfuse trio and accepts a self-hosted URL', () => {
    expect(() =>
      validateEnvironment({ LANGFUSE_PUBLIC_KEY: 'pk-lf-test' }),
    ).toThrow(/LANGFUSE_SECRET_KEY/);
    expect(() =>
      validateEnvironment({
        LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
        LANGFUSE_SECRET_KEY: 'sk-lf-test',
        LANGFUSE_BASE_URL: 'notaurl',
      }),
    ).toThrow(/LANGFUSE_BASE_URL/);
    expect(
      validateEnvironment({
        LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
        LANGFUSE_SECRET_KEY: 'sk-lf-test',
        LANGFUSE_BASE_URL: 'http://localhost:3100',
      }).LANGFUSE_ENABLED,
    ).toBe(true);
  });

  it('keeps trace payloads off unless the environment turns them on', () => {
    expect(validateEnvironment({}).TRACE_PAYLOADS).toBe(false);
    expect(validateEnvironment({ TRACE_PAYLOADS: 'true' }).TRACE_PAYLOADS).toBe(
      true,
    );
    expect(validateEnvironment({ TRACE_PAYLOADS: '' }).TRACE_PAYLOADS).toBe(
      false,
    );
    expect(() => validateEnvironment({ TRACE_PAYLOADS: 'sometimes' })).toThrow(
      /TRACE_PAYLOADS/,
    );
  });
});
