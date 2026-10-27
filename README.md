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

<details>
<summary><h2>Configuration</h2></summary>

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
| `ACCOUNT_PASSWORD` | empty                | Login secret for every workspace. Blank starts a workspace without one.     |

Never use `*` in `CORS_ORIGINS`. The server accepts only complete HTTP or HTTPS origins without paths.

</details>

<details>
<summary><h2>OpenAI agents</h2></summary>

`OpenaiService` is global. Inject it where you create or run an agent. `OPENAI_API_KEY` is registered once at startup and is shared by every agent.

`instructions` is the agent's job description. `prompt` is the question for one run. `context` is optional data your code can read, such as a user id or a database client. The model reads the instructions and the prompt. Context stays in your code.

### Create an agent

```typescript
const historyTutor = this.openai.createAgent(
  'History tutor',
  'You answer history questions clearly and concisely.',
  { model: 'gpt-6-astra' },
);
```

### Add a tool

`sampleTool` lives in `src/config/tools/sample.tool.ts`.

```typescript
import { sampleTool } from '@/config/tools';

const historyTutor = this.openai.createAgent(
  'History tutor',
  'You answer history questions clearly and concisely.',
  { model: 'gpt-6-astra', tools: [sampleTool] },
);
```

### Add an output schema

`sampleSchema` lives in `src/config/schema/sample.schema.ts`.

```typescript
import { sampleSchema } from '@/config/schema';

const calendarExtractor = this.openai.createAgent(
  'Calendar extractor',
  'Extract calendar events from the supplied text.',
  { model: 'gpt-6-astra', schema: sampleSchema },
);
```

### Add a handoff description

`handoffDescription` is optional on a normal agent.

```typescript
const historyTutor = this.openai.createAgent(
  'History tutor',
  'You answer history questions clearly and concisely.',
  {
    model: 'gpt-6-astra',
    handoffDescription: 'Specialist for historical questions',
  },
);
```

### Shared runner model

Call `createRunner` only when agents should share a fallback model. An agent that sets `model` keeps its own model. An agent that leaves `model` out uses the runner model. Skip `createRunner` when every agent sets its own model.

```typescript
this.openai.createRunner('gpt-6-astra');

const fastAgent = this.openai.createAgent(
  'Fast support agent',
  'Handle routine support questions.',
  { model: 'gpt-5.6-terra' },
);

const generalAgent = this.openai.createAgent(
  'General support agent',
  'Handle support questions carefully.',
);

await this.openai.runAgent('Summarize ticket 123.', fastAgent);

const result = await this.openai.runAgent(
  'Investigate the billing issue on account 456.',
  generalAgent,
);
```

The first run uses `gpt-5.6-terra`. The second run uses `gpt-6-astra`. `result.finalOutput` is the billing answer.

### Reasoning effort

Every agent starts at medium reasoning effort. Pass `modelSettings` to change it. Reasoning effort changes how long the model thinks.

```typescript
const fastAgent = this.openai.createAgent(
  'Fast support agent',
  'Handle routine support questions.',
  {
    model: 'gpt-5.6-terra',
    modelSettings: { reasoning: { effort: 'low' } },
  },
);
```

Leave `modelSettings` out and the effort stays `medium`.

### Temperature

`temperature` is optional. Leave it out and the request does not send one. `0` keeps the wording steady. A higher number, such as `1`, lets the wording vary. `gpt-6-astra` rejects a custom temperature, so leave it out for that model.

```typescript
const writer = this.openai.createAgent(
  'Writer',
  'Rewrite the note in a warmer tone.',
  { model: 'gpt-5.6-terra', temperature: 0.7 },
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
  { context: { userId: '123' } },
);
```

### Continue a chat

`createSession` starts a notebook for one chat. Pass that same session on every later message. A one-off question can leave it out. The notebook lives in memory and is cleared when the process stops.

```typescript
const chat = this.openai.createSession();

await this.openai.runAgent('Who was the first Roman emperor?', historyTutor, {
  session: chat,
});

const result = await this.openai.runAgent(
  'How long did he rule?',
  historyTutor,
  {
    session: chat,
  },
);
```

The second question can mention the first answer because both runs share `chat`.

### WebSocket

Turn `websocket` on when one request will make the agent call the model several times, such as a tool, then another model call, then another tool. A single question and answer can leave it off.

```typescript
const result = await this.openai.runAgent(
  'Find three sources and save a summary.',
  researcher,
  { session: chat, websocket: true },
);
```

### Triage

Build the specialists first. Each specialist can carry an optional `handoffDescription`. The triage agent requires one, so another agent knows when to hand off to it. Pass the triage agent to `runAgent`. It reads the prompt and hands the question to one specialist.

```typescript
const historyTutor = this.openai.createAgent(
  'History tutor',
  'You answer history questions clearly and concisely.',
  {
    model: 'gpt-6-astra',
    handoffDescription: 'Specialist for historical questions',
  },
);

const mathTutor = this.openai.createAgent(
  'Math tutor',
  'You explain math step by step.',
  {
    model: 'gpt-6-astra',
    handoffDescription: 'Specialist for math questions',
  },
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
  { context: { userId: '123' } },
);
```

### Tool, schema, and handoff description together

```typescript
import { sampleSchema } from '@/config/schema';
import { sampleTool } from '@/config/tools';

const historyTutor = this.openai.createAgent(
  'History tutor',
  'You answer history questions clearly and concisely.',
  {
    model: 'gpt-6-astra',
    tools: [sampleTool],
    schema: sampleSchema,
    handoffDescription: 'Specialist for historical questions',
  },
);

const result = await this.openai.runAgent(
  'Who was the first Roman emperor?',
  historyTutor,
  { context: { userId: '123' } },
);
```

</details>

<details>
<summary><h2>Sandbox</h2></summary>

`SandboxService` opens a workspace computer. The chat stays in `OpenaiService`. A workspace is where files, commands, and a logged-in browser live.

Every sandbox agent starts with three capabilities:

- `shell` runs commands.
- `filesystem` reads and edits files.
- `compaction` shortens a long run so it can continue.

`skills` and `memory` are optional. Pass `skills` when the agent should load a skill folder or repo. Pass `memory: true` when a later run should read lessons from earlier workspace work.

### Create a sandbox agent

```typescript
const agent = this.sandbox.createSandboxAgent(
  'Workspace agent',
  'Use this computer. Browse, edit files, and continue work already in the workspace.',
  { model: 'gpt-6-astra' },
);
```

### Create a manifest

`createManifest` builds the starting contents of a workspace. Call it with no argument for an empty computer. Pass `files` for text files, `repo` for a GitHub boilerplate to clone, `entries` for a mount, and `environment` for values the workspace needs at startup. Give the result to `openSandbox`.

An empty computer, for browsing:

```typescript
import { createManifest } from '@/config/workspace';

const workspace = await this.sandbox.openSandbox(createManifest());
```

A website:

```typescript
const workspace = await this.sandbox.openSandbox(
  createManifest({
    files: {
      'site/index.html': '<h1>Bakery</h1>',
      'site/styles.css': 'body { font-family: sans-serif; }',
    },
  }),
);
```

A folder of notes:

```typescript
const workspace = await this.sandbox.openSandbox(
  createManifest({
    files: {
      'notes/brief.md': '# Account brief\n\nRenewal date: 2026-04-15.',
      'notes/risks.md': '# Risks\n\nSecurity questionnaire is not complete.',
    },
  }),
);
```

A GitHub boilerplate to clone:

```typescript
const workspace = await this.sandbox.openSandbox(
  createManifest({
    repo: 'https://github.com/owner/next-starter',
  }),
);
```

`repo` can be an `owner/name` slug, a `https://github.com/...` link, or a `git@github.com:...` clone URL. Add `path` and `ref` when the folder name or branch should differ:

```typescript
const workspace = await this.sandbox.openSandbox(
  createManifest({
    repo: {
      url: 'https://github.com/owner/next-starter/tree/main',
      path: 'app',
    },
    files: {
      'task.md': 'Turn this starter into a bakery homepage.',
    },
  }),
);
```

### Open a workspace and run

`openSandbox` starts the computer. Pass the same workspace on the next run to keep the same files and browser. `chat` is optional and comes from `this.openai.createSession()`.

```typescript
const workspace = await this.sandbox.openSandbox();

const result = await this.sandbox.runSandbox(
  'Check the latest comment on my account.',
  agent,
  { workspace },
);
```

### Continue in the same workspace

```typescript
const chat = this.openai.createSession();
const workspace = await this.sandbox.openSandbox();

await this.sandbox.runSandbox(
  'Check the latest comment on my account.',
  agent,
  {
    chat,
    workspace,
  },
);

await this.sandbox.runSandbox('Reply that I will call tomorrow.', agent, {
  chat,
  workspace,
});
```

### Add skills

A skill is a folder with a `SKILL.md` file. Pass exactly one source: `skills` for text you write here, `from` for a folder the workspace loads up front, or `lazyFrom` for a folder the agent opens only when it needs that skill.

Write one skill in the call:

```typescript
const agent = this.sandbox.createSandboxAgent(
  'Workspace agent',
  'Follow the review skill before you edit the site.',
  {
    model: 'gpt-6-astra',
    skills: {
      skills: [
        {
          name: 'review',
          description: 'Review a page before publishing it.',
          content: '# Review\n\nCheck the heading, then the links.',
        },
      ],
    },
  },
);
```

Load a GitHub repo whose top-level folders each contain a `SKILL.md`:

```typescript
import { gitRepo } from '@openai/agents/sandbox';

const agent = this.sandbox.createSandboxAgent(
  'Workspace agent',
  'Use a skill from the repo when the task matches it.',
  {
    model: 'gpt-6-astra',
    skills: {
      from: gitRepo({
        repo: 'https://github.com/owner/agent-skills',
        ref: 'main',
      }),
    },
  },
);
```

A skills.sh page is a catalog. The SDK does not fetch skills.sh or install an npm package. Copy the GitHub link that page shows and pass it to `gitRepo`. If the skill files sit in a subfolder, set `subpath`.

Load one skill from that repo only when the agent asks for it:

```typescript
const agent = this.sandbox.createSandboxAgent(
  'Workspace agent',
  'Load the review skill before you edit the site.',
  {
    model: 'gpt-6-astra',
    skills: {
      lazyFrom: {
        source: gitRepo({ repo: 'https://github.com/owner/agent-skills' }),
        index: [
          {
            name: 'review',
            description: 'Review a page before publishing it.',
            path: 'review',
          },
        ],
      },
    },
  },
);
```

### Add memory

`memory: true` lets a later run read lessons from earlier workspace work, and it writes new lessons after a run.

```typescript
const agent = this.sandbox.createSandboxAgent(
  'Workspace agent',
  'Remember account names and open questions. Skip passwords.',
  {
    model: 'gpt-6-astra',
    memory: true,
  },
);
```

Read old lessons without writing new ones:

```typescript
const agent = this.sandbox.createSandboxAgent(
  'Workspace agent',
  'Use what you already learned. Do not store new notes.',
  {
    model: 'gpt-6-astra',
    memory: { read: true, generate: false },
  },
);
```

Tell the memory writer what to keep:

```typescript
const agent = this.sandbox.createSandboxAgent(
  'Workspace agent',
  'Keep useful lessons for the next run.',
  {
    model: 'gpt-6-astra',
    memory: {
      generate: {
        extraPrompt: 'Remember account names and open questions. Skip passwords.',
      },
    },
  },
);
```

### Account password

`ACCOUNT_PASSWORD` is one server secret. Put it in `.env` once:

```bash
ACCOUNT_PASSWORD=the-login-secret
```

`openSandbox` reads that value and places it in the workspace environment. The agent can use it from the computer when a site asks for a password. Leave the variable empty and the workspace starts without it.

A person does not type it on each message, and it is not written into the prompt. Every workspace this server opens receives the same secret.

</details>

<details>
<summary><h2>Health checks</h2></summary>

- `GET /v1/health/live` proves that the process can answer requests.
- `GET /v1/health/ready` checks the process's memory limits.

Both routes also support API version 2. The checks do not depend on external websites, databases, or Redis.

</details>

<details>
<summary><h2>Verification</h2></summary>

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

</details>

<details>
<summary><h2>Container deployment</h2></summary>

Build and run the same OCI image on Docker, Kubernetes, Nomad, ECS, Cloud Run, Fly.io, Railway, Render, or any compatible platform:

```bash
docker build --tag agentic:local .
docker run --rm --read-only --tmpfs /tmp --publish 3000:3000 agentic:local
```

The image uses pinned Bun and Node digests, contains production dependencies only, and runs as the unprivileged `node` user.

</details>

<details>
<summary><h2>CI/CD</h2></summary>

`.github/workflows/ci.yml` installs the lockfile exactly, checks formatting and types, runs all tests, audits dependencies, builds the application and container, and scans the runtime image. Every external action is pinned to a full commit SHA.

`.github/workflows/release.yml` verifies semantic-version tags, then publishes Linux AMD64 and ARM64 images to GitHub Container Registry. It creates an SBOM and signs a provenance attestation through GitHub OIDC. Configure protection rules and required reviewers on the repository's `production` environment before the first release.

Create a release with an immutable semantic version:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The workflow delivers a portable image. Each hosting platform can deploy that immutable image digest with its own native rollout and rollback controls.

</details>

## Reliability and state

The service is stateless. It does not pretend that memory or a container filesystem is durable. Add workflow and idempotency modules only with a shared production store and tested transaction boundaries. Until then, replicas can start, stop, and roll back without losing application-owned state because the application owns none.

The application enables graceful NestJS shutdown hooks. Its global exception filter also handles exceptions thrown by middleware, assigns a safe request ID, logs unexpected server errors, and keeps internal error details out of client responses.

## NestJS guidance applied

This project follows the current NestJS guidance for [exception filters](https://docs.nestjs.com/exception-filters), [security headers](https://docs.nestjs.com/techniques/security/cors), [CSRF protection](https://docs.nestjs.com/security/csrf), [validation](https://docs.nestjs.com/application/validation), [rate limiting](https://docs.nestjs.com/security/rate-limiting), and [shutdown hooks](https://docs.nestjs.com/fundamentals/lifecycle-events).
