# Agentic

Agentic is a stateless NestJS API foundation for provider-specific agent experiments. The application exposes versioned APIs, health checks, OpenAPI documents, structured responses, and global error handling.

## Requirements

- Bun 1.3.14
- Node.js 24 or later for the production runtime
- Docker or another OCI-compatible container runtime for deployment

## Local development

```bash
cp .env.example .env
bun install --frozen-lockfile
bun run start:dev
```

Swagger UI runs at `http://localhost:3000/api`, and Scalar runs at `http://localhost:3000/docs`. Both use the version-specific OpenAPI documents at `/api/v1-json` and `/api/v2-json`. The application prints every enabled documentation URL when it starts.

## Configuration

The application validates configuration before it starts. Invalid ports, booleans, and CORS origins stop startup.

| Variable          | Default               | Purpose                                                                     |
| ----------------- | --------------------- | --------------------------------------------------------------------------- |
| `NODE_ENV`        | `development`         | Selects development, test, or production behavior.                          |
| `PORT`            | `3000`                | Sets the HTTP port.                                                         |
| `PLATFORM_NAME`   | `Agentic`             | Names the API and OpenAPI document.                                         |
| `CORS_ORIGINS`    | empty                 | Lists exact, comma-separated browser origins. Empty disables CORS.          |
| `SWAGGER_ENABLED` | on outside production | Enables Swagger, Scalar, and OpenAPI JSON. Set it explicitly in production. |
| `OBSERVE_ENABLED` | `false`               | Enables NestJS Observe when valid credentials are present.                  |
| `OPENAI_API_KEY`  | empty                 | Authenticates every OpenAI agent. Blank leaves the shared key unset.        |

Never use `*` in `CORS_ORIGINS`. The server accepts only complete HTTP or HTTPS origins without paths.

## OpenAI agents

`OpenaiService` is global. Inject it where you create or run an agent. `OPENAI_API_KEY` is registered once at startup and is shared by every agent.

`instructions` is the agent's job description. `prompt` is the question for one run. `context` is optional data your code can read, such as a user id or a database client. The model reads the instructions and the prompt. Context stays in your code.

### Create an agent

```typescript
const historyTutor = this.openai.createAgent(
  'History tutor',
  'You answer history questions clearly and concisely.',
  'gpt-6-astra',
);
```

### Add a tool

`sampleTool` lives in `src/config/tools/sample.tool.ts`.

```typescript
import { sampleTool } from '@/config/tools';

const historyTutor = this.openai.createAgent(
  'History tutor',
  'You answer history questions clearly and concisely.',
  'gpt-6-astra',
  [sampleTool],
);
```

### Add an output schema

`sampleSchema` lives in `src/config/schema/sample.schema.ts`. Pass `undefined` for tools when the agent has a schema and no tools.

```typescript
import { sampleSchema } from '@/config/schema';

const calendarExtractor = this.openai.createAgent(
  'Calendar extractor',
  'Extract calendar events from the supplied text.',
  'gpt-6-astra',
  undefined,
  sampleSchema,
);
```

### Add a handoff description

`handoffDescription` is optional on a normal agent. Pass `undefined` for tools and schema when you only want the description.

```typescript
const historyTutor = this.openai.createAgent(
  'History tutor',
  'You answer history questions clearly and concisely.',
  'gpt-6-astra',
  undefined,
  undefined,
  'Specialist for historical questions',
);
```

### Run an agent

```typescript
const result = await this.openai.runAgent(
  'Who was the first Roman emperor?',
  historyTutor,
);
```

### Run with context

Leave the third argument out when the run has no local data.

```typescript
const result = await this.openai.runAgent(
  'Who was the first Roman emperor?',
  historyTutor,
  { userId: '123' },
);
```

### Triage

Build the specialists first. Each specialist can carry an optional `handoffDescription`. The triage agent requires one, so another agent knows when to hand off to it. Pass the triage agent to `runAgent`. It reads the prompt and hands the question to one specialist.

```typescript
const historyTutor = this.openai.createAgent(
  'History tutor',
  'You answer history questions clearly and concisely.',
  'gpt-6-astra',
  undefined,
  undefined,
  'Specialist for historical questions',
);

const mathTutor = this.openai.createAgent(
  'Math tutor',
  'You explain math step by step.',
  'gpt-6-astra',
  undefined,
  undefined,
  'Specialist for math questions',
);

const triage = this.openai.createTriageAgent(
  'Homework triage',
  'Route each homework question to the right specialist.',
  [historyTutor, mathTutor],
  'Routes homework questions to the right specialist',
);

const result = await this.openai.runAgent(
  'Who was the first Roman emperor?',
  triage,
  { userId: '123' },
);
```

### Tool, schema, and handoff description together

```typescript
import { sampleSchema } from '@/config/schema';
import { sampleTool } from '@/config/tools';

const historyTutor = this.openai.createAgent(
  'History tutor',
  'You answer history questions clearly and concisely.',
  'gpt-6-astra',
  [sampleTool],
  sampleSchema,
  'Specialist for historical questions',
);

const result = await this.openai.runAgent(
  'Who was the first Roman emperor?',
  historyTutor,
  { userId: '123' },
);
```

## Health checks

- `GET /v1/health/live` proves that the process can answer requests.
- `GET /v1/health/ready` checks the process's memory limits.

Both routes also support API version 2. The checks do not depend on external websites, databases, or Redis.

## Verification

All tests live under `test/`.

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run test:e2e
bun run test:cov
bun run build
```

## Container deployment

Build and run the same OCI image on Docker, Kubernetes, Nomad, ECS, Cloud Run, Fly.io, Railway, Render, or any compatible platform:

```bash
docker build --tag agentic:local .
docker run --rm --read-only --tmpfs /tmp --publish 3000:3000 agentic:local
```

The image uses pinned Bun and Node digests, contains production dependencies only, and runs as the unprivileged `node` user.

## CI/CD

`.github/workflows/ci.yml` installs the lockfile exactly, checks formatting and types, runs all tests, audits dependencies, builds the application and container, and scans the runtime image. Every external action is pinned to a full commit SHA.

`.github/workflows/release.yml` verifies semantic-version tags, then publishes Linux AMD64 and ARM64 images to GitHub Container Registry. It creates an SBOM and signs a provenance attestation through GitHub OIDC. Configure protection rules and required reviewers on the repository's `production` environment before the first release.

Create a release with an immutable semantic version:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The workflow delivers a portable image. Each hosting platform can deploy that immutable image digest with its own native rollout and rollback controls.

## Reliability and state

The service is stateless. It does not pretend that memory or a container filesystem is durable. Add workflow and idempotency modules only with a shared production store and tested transaction boundaries. Until then, replicas can start, stop, and roll back without losing application-owned state because the application owns none.

The application enables graceful NestJS shutdown hooks. Its global exception filter also handles exceptions thrown by middleware, assigns a safe request ID, logs unexpected server errors, and keeps internal error details out of client responses.

## NestJS guidance applied

This project follows the current NestJS guidance for [exception filters](https://docs.nestjs.com/exception-filters), [security headers](https://docs.nestjs.com/techniques/security/cors), [CSRF protection](https://docs.nestjs.com/security/csrf), [validation](https://docs.nestjs.com/application/validation), [rate limiting](https://docs.nestjs.com/security/rate-limiting), and [shutdown hooks](https://docs.nestjs.com/fundamentals/lifecycle-events).
