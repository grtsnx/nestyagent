import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app';
import { configureApplication } from '@/bootstrap/application.js';
import { validateEnvironment } from '@/config/index.js';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ logger: false });
    configureApplication(
      app,
      validateEnvironment({
        NODE_ENV: 'test',
        SWAGGER_ENABLED: true,
        CORS_ORIGINS: 'https://app.example.com',
      }),
    );
    await app.init();
  });

  it('returns security headers and a request ID', async () => {
    const response = await request(app.getHttpServer()).get('/v1');

    expect(response.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
    });
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-request-id']).toMatch(/^[\w.-]{1,64}$/);
    expect(response.headers['content-security-policy']).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it('applies exact-origin CORS without reflecting untrusted origins', async () => {
    const allowed = await request(app.getHttpServer())
      .options('/v1')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);
    const rejected = await request(app.getHttpServer())
      .options('/v1')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);

    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://app.example.com',
    );
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('adds security headers and a request ID to CSRF rejections', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1')
      .set('Origin', 'https://evil.example.com')
      .set('Sec-Fetch-Site', 'cross-site')
      .expect(403);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-request-id']).toMatch(/^[\w.-]{1,64}$/);
    expect(response.body).toMatchObject({
      statusCode: 403,
      requestId: response.headers['x-request-id'],
    });
  });

  it('replaces an invalid caller-supplied request ID', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1')
      .set('x-request-id', '<script>alert(1)</script>')
      .expect(200);

    expect(response.headers['x-request-id']).toMatch(/^[\w.-]{1,64}$/);
    expect(response.headers['x-request-id']).not.toContain('script');
  });

  it('returns sanitized global errors for missing routes', async () => {
    const response = await request(app.getHttpServer())
      .get('/missing')
      .set('x-request-id', 'test-request-123')
      .expect(404);

    expect(response.body).toMatchObject({
      statusCode: 404,
      statusType: 'NOT_FOUND',
      requestId: 'test-request-123',
      path: '/missing',
    });
    expect(response.body.timestamp).toEqual(expect.any(String));
  });

  it.each(['/v1/health/live', '/v2/health/live'])(
    '%s exposes a dependency-free liveness check',
    async (path) => {
      const response = await request(app.getHttpServer()).get(path).expect(200);
      expect(response.body.data).toEqual({ status: 'ok' });
    },
  );

  it('does not throttle dependency-free liveness probes', async () => {
    const responses = [];
    for (let index = 0; index < 105; index += 1) {
      responses.push(await request(app.getHttpServer()).get('/v1/health/live'));
    }

    expect(responses.every(({ status }) => status === 200)).toBe(true);
  });

  it('serves populated, version-specific OpenAPI documents', async () => {
    const v1 = await request(app.getHttpServer())
      .get('/api/v1-json')
      .expect(200);
    const v2 = await request(app.getHttpServer())
      .get('/api/v2-json')
      .expect(200);

    expect(v1.body.info.version).toBe('v1');
    expect(v1.body.tags).toContainEqual({
      name: 'Server',
      description: 'Core server status, health, and connectivity endpoints.',
    });
    expect(v1.body.paths).toHaveProperty('/v1');
    expect(v1.body.paths).not.toHaveProperty('/v2');
    expect(v2.body.info.version).toBe('v2');
    expect(v2.body.paths).toHaveProperty('/v2');
    expect(v2.body.paths).not.toHaveProperty('/v1');
  });

  it('serves Swagger with consistent themes and a compact version picker', async () => {
    const response = await request(app.getHttpServer()).get('/api').expect(200);
    const initializer = await request(app.getHttpServer())
      .get('/api/swagger-ui-init.js')
      .expect(200);

    expect(response.text).toContain('swagger-ui-bundle.js');
    expect(response.text).not.toContain('MutationObserver');
    expect(response.text).not.toContain("classList.remove('dark-mode')");
    expect(response.text).toContain(
      '.swagger-ui .topbar .download-url-wrapper { display: none; }',
    );
    expect(response.text).toContain('.swagger-ui .topbar { display: none; }');
    expect(response.text).toContain('api-version-picker');
    expect(response.text).toContain('max-width: 220px');
    expect(response.text).toContain(
      '.swagger-ui .topbar .dark-mode-toggle { display: none; }',
    );
    expect(response.text).toContain('api-theme-toggle');
    expect(initializer.text).toContain(
      'setAttribute("aria-label", "API version")',
    );
    expect(initializer.text).toContain('setAttribute("aria-label", label)');
    expect(response.text).toContain('html.dark-mode body');
  });

  it('serves Scalar with both versioned OpenAPI documents', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs')
      .expect(200);

    expect(response.text).toContain('Scalar.createApiReference');
    expect(response.text).toContain(
      'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.0',
    );
    expect(response.text).toContain('/api/v1-json');
    expect(response.text).toContain('/api/v2-json');
    expect(response.headers['content-security-policy']).toContain(
      'https://cdn.jsdelivr.net',
    );
  });

  it.each(['/v1', '/v2'])('%s (GET)', async (path) => {
    await request(app.getHttpServer()).get(path).expect(200).expect({
      statusCode: 200,
      statusType: 'OK',
      message: 'Success',
      data: 'Hello World!',
    });
  });

  afterEach(async () => {
    await app.close();
  });
});
