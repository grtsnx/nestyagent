import { ConsoleLogger } from '@nestjs/common';
import { createApplication } from '@/bootstrap/application.js';

const { app, environment } = await createApplication();
await app.listen(environment.PORT, '0.0.0.0');

const baseUrl = `http://localhost:${environment.PORT}`;
const logger = new ConsoleLogger('Bootstrap');
logger.log(`Application: ${baseUrl}`);

if (environment.SWAGGER_ENABLED) {
  logger.log(`Swagger UI: ${baseUrl}/api`);
  logger.log(`Scalar API reference: ${baseUrl}/docs`);
  logger.log(`OpenAPI v1: ${baseUrl}/api/v1-json`);
  logger.log(`OpenAPI v2: ${baseUrl}/api/v2-json`);
}
