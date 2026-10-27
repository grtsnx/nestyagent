import { z } from 'zod';

const environments = ['development', 'production', 'test'] as const;

const booleanValue = (name: string) =>
  z.preprocess(
    (value) => {
      if (typeof value === 'boolean') return value;
      if (typeof value !== 'string') return value;

      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
      if (['false', '0', 'off', 'no'].includes(normalized)) return false;
      return value;
    },
    z.boolean({ error: `${name} must be a boolean` }),
  );

function optionalSecret() {
  return z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  );
}

function corsOrigins(value: unknown): string[] {
  if (value === undefined || value === '') return [];
  const values = Array.isArray(value) ? value : String(value).split(',');
  const origins = values
    .map(String)
    .map((origin) => origin.trim())
    .filter(Boolean);

  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`CORS_ORIGINS contains an invalid origin: ${origin}`);
    }

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== origin ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw new Error(
        `CORS_ORIGINS must contain exact http(s) origins without paths: ${origin}`,
      );
    }
  }

  return [...new Set(origins)];
}

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(environments).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    PLATFORM_NAME: z.string().trim().min(1).default('Agentic'),
    CORS_ORIGINS: z.unknown().optional(),
    OBSERVE_ENABLED: booleanValue('OBSERVE_ENABLED').optional(),
    OBSERVE_APP_KEY: z.string().trim().optional(),
    OBSERVE_APP_SECRET: z.string().trim().optional(),
    OBSERVE_SERVICE_ID: z.string().trim().optional(),
    SWAGGER_ENABLED: booleanValue('SWAGGER_ENABLED').optional(),
    OPENAI_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().trim().min(1).optional(),
    ),
    ACCOUNT_PASSWORD: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().trim().min(1).optional(),
    ),
    OPENAI_EXECUTOR_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().trim().min(1).optional(),
    ),
    OPENAI_WEBHOOK_SECRET: optionalSecret(),
    REMOTE_MACHINE_PROVIDER: z
      .enum(['local', 'aws', 'digitalocean', 'databricks', 'oci'])
      .optional(),
    AWS_MICROVM_IMAGE_ARN: optionalSecret(),
    AWS_MICROVM_EXECUTION_ROLE: optionalSecret(),
    AWS_MICROVM_SECRET_ARN: optionalSecret(),
    AWS_REGION: optionalSecret(),
    DIGITALOCEAN_TOKEN: optionalSecret(),
    DATABRICKS_HOST: optionalSecret(),
    DATABRICKS_TOKEN: optionalSecret(),
    OCI_SANDBOX_PROJECT_ID: optionalSecret(),
    OCI_SANDBOX_TOKEN: optionalSecret(),
    OCI_SANDBOX_CREATE_URL: optionalSecret(),
    CLOUDFLARE_SANDBOX_WORKER_URL: optionalSecret(),
    CLOUDFLARE_SANDBOX_API_KEY: optionalSecret(),
  })
  .superRefine((environment, context) => {
    if (!environment.OBSERVE_ENABLED) return;

    for (const key of [
      'OBSERVE_APP_KEY',
      'OBSERVE_APP_SECRET',
      'OBSERVE_SERVICE_ID',
    ] as const) {
      if (!environment[key]) {
        context.addIssue({
          code: 'custom',
          message: `${key} is required when OBSERVE_ENABLED is true`,
          path: [key],
        });
      }
    }
  });

export interface Environment {
  NODE_ENV: (typeof environments)[number];
  PORT: number;
  PLATFORM_NAME: string;
  CORS_ORIGINS: string[];
  OBSERVE_ENABLED: boolean;
  OBSERVE_APP_KEY?: string;
  OBSERVE_APP_SECRET?: string;
  OBSERVE_SERVICE_ID?: string;
  SWAGGER_ENABLED: boolean;
  OPENAI_API_KEY?: string;
  ACCOUNT_PASSWORD?: string;
  OPENAI_EXECUTOR_API_KEY?: string;
  OPENAI_WEBHOOK_SECRET?: string;
  REMOTE_MACHINE_PROVIDER?:
    'local' | 'aws' | 'digitalocean' | 'databricks' | 'oci';
  AWS_MICROVM_IMAGE_ARN?: string;
  AWS_MICROVM_EXECUTION_ROLE?: string;
  AWS_MICROVM_SECRET_ARN?: string;
  AWS_REGION?: string;
  DIGITALOCEAN_TOKEN?: string;
  DATABRICKS_HOST?: string;
  DATABRICKS_TOKEN?: string;
  OCI_SANDBOX_PROJECT_ID?: string;
  OCI_SANDBOX_TOKEN?: string;
  OCI_SANDBOX_CREATE_URL?: string;
  CLOUDFLARE_SANDBOX_WORKER_URL?: string;
  CLOUDFLARE_SANDBOX_API_KEY?: string;
}

export function validateEnvironment(
  values: Record<string, unknown>,
): Environment {
  const parsed = environmentSchema.parse(values);
  return {
    ...parsed,
    CORS_ORIGINS: corsOrigins(parsed.CORS_ORIGINS),
    OBSERVE_ENABLED: parsed.OBSERVE_ENABLED ?? false,
    SWAGGER_ENABLED: parsed.SWAGGER_ENABLED ?? parsed.NODE_ENV !== 'production',
  };
}
