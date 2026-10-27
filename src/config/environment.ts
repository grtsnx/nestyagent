import { z } from 'zod';

const environments = ['development', 'production', 'test'] as const;

export const remoteMachineProviders = [
  'local',
  'aws',
  'digitalocean',
  'databricks',
  'oci',
] as const;
export type RemoteMachineProvider = (typeof remoteMachineProviders)[number];

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

// Blank values are treated as unset.
function optionalString() {
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
    DATABASE_URL: optionalString(),
    OPENAI_API_KEY: optionalString(),
    OPENAI_HOSTED_MODEL: optionalString(),
    ACCOUNT_PASSWORD: optionalString(),
    OPENAI_EXECUTOR_API_KEY: optionalString(),
    OPENAI_WEBHOOK_SECRET: optionalString(),
    REMOTE_MACHINE_PROVIDER: z.enum(remoteMachineProviders).optional(),
    AWS_MICROVM_IMAGE_ARN: optionalString(),
    AWS_MICROVM_EXECUTION_ROLE: optionalString(),
    AWS_MICROVM_SECRET_ARN: optionalString(),
    AWS_REGION: optionalString(),
    DIGITALOCEAN_TOKEN: optionalString(),
    DATABRICKS_HOST: optionalString(),
    DATABRICKS_TOKEN: optionalString(),
    OCI_SANDBOX_PROJECT_ID: optionalString(),
    OCI_SANDBOX_TOKEN: optionalString(),
    OCI_SANDBOX_CREATE_URL: optionalString(),
    CLOUDFLARE_SANDBOX_WORKER_URL: optionalString(),
    CLOUDFLARE_SANDBOX_API_KEY: optionalString(),
    LANGFUSE_PUBLIC_KEY: optionalString(),
    LANGFUSE_SECRET_KEY: optionalString(),
    LANGFUSE_BASE_URL: optionalString(),
    COMPOSIO_API_KEY: optionalString(),
    // Admin secret for editing helper instructions. Long, so it cannot be guessed.
    ADMIN_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .trim()
        .min(32, 'ADMIN_API_KEY must be at least 32 characters')
        .optional(),
    ),
    TRACE_PAYLOADS: z.preprocess(
      (value) => (value === '' ? undefined : value),
      booleanValue('TRACE_PAYLOADS').optional(),
    ),
  })
  .superRefine((environment, context) => {
    if (environment.OBSERVE_ENABLED) {
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
    }

    const langfuse = [
      'LANGFUSE_PUBLIC_KEY',
      'LANGFUSE_SECRET_KEY',
      'LANGFUSE_BASE_URL',
    ] as const;
    const present = langfuse.filter((key) => environment[key]);
    if (present.length === 0) return;
    for (const key of langfuse) {
      if (!environment[key]) {
        context.addIssue({
          code: 'custom',
          message: `${key} is required when Langfuse is configured`,
          path: [key],
        });
      }
    }
    if (!environment.LANGFUSE_BASE_URL) return;
    try {
      const url = new URL(environment.LANGFUSE_BASE_URL);
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('protocol');
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'LANGFUSE_BASE_URL must be an http(s) URL',
        path: ['LANGFUSE_BASE_URL'],
      });
    }
  });

// The parsed values, with the defaults validateEnvironment fills in.
export type Environment = Omit<
  z.output<typeof environmentSchema>,
  'CORS_ORIGINS' | 'OBSERVE_ENABLED' | 'SWAGGER_ENABLED' | 'TRACE_PAYLOADS'
> & {
  CORS_ORIGINS: string[];
  OBSERVE_ENABLED: boolean;
  SWAGGER_ENABLED: boolean;
  LANGFUSE_ENABLED: boolean;
  COMPOSIO_ENABLED: boolean;
  TRACE_PAYLOADS: boolean;
};

export function validateEnvironment(
  values: Record<string, unknown>,
): Environment {
  const parsed = environmentSchema.parse(values);
  return {
    ...parsed,
    CORS_ORIGINS: corsOrigins(parsed.CORS_ORIGINS),
    OBSERVE_ENABLED: parsed.OBSERVE_ENABLED ?? false,
    SWAGGER_ENABLED: parsed.SWAGGER_ENABLED ?? parsed.NODE_ENV !== 'production',
    TRACE_PAYLOADS: parsed.TRACE_PAYLOADS ?? false,
    LANGFUSE_ENABLED: Boolean(
      parsed.LANGFUSE_PUBLIC_KEY &&
      parsed.LANGFUSE_SECRET_KEY &&
      parsed.LANGFUSE_BASE_URL,
    ),
    COMPOSIO_ENABLED: Boolean(parsed.COMPOSIO_API_KEY),
  };
}
