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
