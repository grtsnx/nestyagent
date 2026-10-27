# Agentic

Agentic is a stateless NestJS API foundation for provider-specific agent experiments. The application exposes versioned APIs, health checks, OpenAPI documents, structured responses, and global error handling.

## 📋 Requirements

- Bun 1.3.14
- Node.js 24 or later for the production runtime
- Docker or another OCI-compatible container runtime for deployment

<details>
<summary><h2>🛠️ Local development</h2></summary>

```bash
cp .env.example .env
bun install --frozen-lockfile
bun run start:dev
```

Swagger UI runs at `http://localhost:3000/api`, and Scalar runs at `http://localhost:3000/docs`. Both use the version-specific OpenAPI documents at `/api/v1-json` and `/api/v2-json`. The application prints every enabled documentation URL when it starts.

</details>

<details>
<summary><h2>⚙️ Configuration</h2></summary>

The application validates configuration before it starts. Invalid ports, booleans, and CORS origins stop startup.

| Variable                  | Default               | Purpose                                                                              |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `NODE_ENV`                | `development`         | Selects development, test, or production behavior.                                   |
| `PORT`                    | `3000`                | Sets the HTTP port.                                                                  |
| `PLATFORM_NAME`           | `Agentic`             | Names the API and OpenAPI document.                                                  |
| `CORS_ORIGINS`            | empty                 | Lists exact, comma-separated browser origins. Empty disables CORS.                   |
| `SWAGGER_ENABLED`         | on outside production | Enables Swagger, Scalar, and OpenAPI JSON. Set it explicitly in production.          |
| `OBSERVE_ENABLED`         | `false`               | Enables NestJS Observe when valid credentials are present.                           |
| `OPENAI_API_KEY`          | empty                 | Authenticates every OpenAI agent. Blank leaves the shared key unset.                 |
| `ACCOUNT_PASSWORD`        | empty                 | Login secret for every workspace. Blank starts a workspace without one.              |
| `OPENAI_EXECUTOR_API_KEY` | empty                 | Codex environment key from the platform Agents tab. Blank leaves the executor unset. |

> [!CAUTION]
> Never use `*` in `CORS_ORIGINS`. The server accepts only complete HTTP or HTTPS origins without paths.

</details>

<details>
<summary><h2>🤖 OpenAI agents</h2></summary>

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

`temperature` is optional. Leave it out and the request does not send one. `0` keeps the wording steady. A higher number, such as `1`, lets the wording vary.

> [!WARNING]
> `gpt-6-astra` rejects a custom temperature, so leave it out for that model.

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
<summary><h2>💻 Sandbox</h2></summary>

`SandboxService` opens a workspace computer. The chat stays in `OpenaiService`. A workspace is where files, commands, and a logged-in browser live.

Every sandbox agent starts with three capabilities:

- `shell` runs commands.
- `filesystem` reads and edits files.
- `compaction` shortens a long run so it can continue.

`skills` and `memory` are optional. Pass `skills` when the agent should load a skill folder or repo. Pass `memory: true` when a later run should read lessons from earlier workspace work.

The samples below cover these jobs: an empty computer, a website, notes, a cloned starter, files from this Mac, sandbox accounts, a login secret, GitHub, GitLab, Bitbucket, GitBucket, Google Drive, S3, GCS, R2, Azure, and Box, a preview, the same chat, save and resume, Docker, a hosted client, a one-off run, a handoff, a sandbox tool, skills, memory, and a self-hosted executor on this Mac or another machine.

### Create a sandbox agent

```typescript
const agent = this.sandbox.createSandboxAgent(
  'Workspace agent',
  'Use this computer. Browse, edit files, and continue work already in the workspace.',
  { model: 'gpt-6-astra' },
);
```

### Create a manifest

`createManifest` builds the starting contents of a workspace. Call it with no argument for an empty computer. Pass `files` for text files, `localFiles` or `localDirs` to copy from this Mac, `repo` or a git host mount for a boilerplate, `outputDirs` for empty folders, `mounts` for cloud storage or Google Drive, `users` and `groups` for sandbox accounts, and `environment` for startup values. Give the result to `openSandbox`.

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

Copy a folder from this Mac, and give the workspace its own account:

```typescript
const workspace = await this.sandbox.openSandbox(
  createManifest({
    localDirs: { notes: '/Users/me/notes' },
    localFiles: { 'brief.md': '/Users/me/brief.md' },
    outputDirs: ['output'],
    users: ['agent'],
    groups: [{ name: 'editors', users: ['agent'] }],
    environment: { SITE_URL: 'https://bakery.example' },
  }),
);
```

`environment` holds ordinary startup values. `openSandbox` still adds `ACCOUNT_PASSWORD` when this app has one. Pass `entries` only when you already have an SDK entry the helpers above do not build.

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

Open that first workspace with `snapshotDir` when the snapshot should live on disk:

```typescript
const workspace = await this.sandbox.openSandbox(createManifest(), {
  snapshotDir: '/tmp/sandbox-snapshots',
});
```

Lessons in `memories/` stay only while this workspace stays open, you resume it, or you start the next workspace from its snapshot. `closeSandbox` writes those lessons and then the live computer stops.

```typescript
const saved = await this.sandbox.saveSandbox(workspace);
await this.sandbox.closeSandbox(workspace);

const resumed = await this.sandbox.resumeSandbox(saved, {
  snapshotDir: '/tmp/sandbox-snapshots',
});

const dockerResume = await this.sandbox.resumeSandbox(saved, {
  computer: 'docker',
  snapshotDir: '/tmp/sandbox-snapshots',
});

const report = await this.sandbox.readWorkspaceFile(
  resumed,
  'output/report.md',
);
```

A one-off question can skip the saved workspace. The SDK deletes the computer when the run ends.

```typescript
const result = await this.sandbox.runSandboxOnce(
  'Summarize the notes.',
  agent,
  { manifest: createManifest({ files: { 'notes.md': '# Notes' } }) },
);
```

Leave the manifest on the agent when every one-off run should start from the same files:

```typescript
const notesAgent = this.sandbox.createSandboxAgent(
  'Notes agent',
  'Summarize the notes in the workspace.',
  { manifest: createManifest({ files: { 'notes.md': '# Notes' } }) },
);

await this.sandbox.runSandboxOnce('Summarize the notes.', notesAgent);
```

A normal agent can call the sandbox agent as a tool. Pass `workspace` to keep the same files.

```typescript
const sandboxAgent = this.sandbox.createSandboxAgent(
  'Workspace agent',
  'Use the computer for files and commands.',
  { handoffDescription: 'Use for files, commands, and the workspace.' },
);

const intake = this.openai.createTriageAgent(
  'Intake',
  'Hand workspace work to the sandbox agent.',
  [sandboxAgent],
  'Receives a request and routes it.',
);

const workspaceTool = this.sandbox.asTool(sandboxAgent, {
  toolName: 'workspace',
  toolDescription: 'Do the file and command work.',
  workspace,
});

const freshWorkspaceTool = this.sandbox.asTool(sandboxAgent, {
  toolName: 'fresh_workspace',
  toolDescription: 'Do the work in a new Unix workspace.',
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

```typescript
skills: {
  from: gitRepo({
    repo: 'https://github.com/owner/agent-skills',
    subpath: 'skills',
  }),
},
```

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
        extraPrompt:
          'Remember account names and open questions. Skip passwords.',
      },
    },
  },
);
```

Write new lessons without reading old ones:

```typescript
const agent = this.sandbox.createSandboxAgent(
  'Workspace agent',
  'Store what this run learns. Ignore older notes.',
  {
    model: 'gpt-6-astra',
    memory: { read: false, generate: true },
  },
);
```

Two agents in one workspace keep separate lessons:

```typescript
const reviewer = this.sandbox.createSandboxAgent(
  'Reviewer',
  'Review the site and keep your own notes.',
  {
    memory: { layout: { directory: 'memories/reviewer' } },
  },
);

const editor = this.sandbox.createSandboxAgent(
  'Editor',
  'Edit the site and keep your own notes.',
  {
    memory: { layout: { directory: 'memories/editor' } },
  },
);
```

### Account password

The SDK does not ask a person for a password and does not fetch one. This NestJS app supplies one secret, and `openSandbox` copies it into the computer. The app is the process started with `bun run start:dev`. It is not OpenAI, and it is not the website the agent logs into.

1. Put the password in `.env`:

```bash
ACCOUNT_PASSWORD=the-login-secret
```

2. Restart this app. Startup keeps the value only when it is not blank.
3. Call `openSandbox`. The service reads `ACCOUNT_PASSWORD` from the validated environment.
4. The workspace starts with that name set in its environment.
5. The agent reads `$ACCOUNT_PASSWORD` inside the computer when a login form needs it. Other environment values on the manifest stay in place.

> [!WARNING]
> The password is ephemeral. A saved workspace does not keep it.

Leave the variable empty and step 3 skips it. The workspace starts without a password. The value is not written into the prompt, and a person does not type it on each message.

Pass `password` when this workspace belongs to a different person. That value replaces the shared secret for this call only.

```typescript
const workspace = await this.sandbox.openSandbox(createManifest(), {
  password: this.user.accountPassword,
});
```

### Mount GitHub or Google Drive

A `github`, `gitlab`, or `bitbucket` mount clones that repo into the folder you name. GitBucket uses the same `/tree/<branch>` shape as GitHub, so pass that URL with `provider: 'github'`. A `google-drive` mount uses rclone, because the SDK has no Drive client of its own. `remote` defaults to `gdrive:`. Point `configFile` at an rclone config when the token is not already on the machine.

```typescript
const workspace = await this.sandbox.openSandbox(
  createManifest({
    mounts: {
      app: {
        provider: 'github',
        url: 'https://github.com/owner/next-starter',
        ref: 'main',
      },
      api: {
        provider: 'gitlab',
        url: 'https://gitlab.com/owner/api/-/tree/main',
      },
      web: {
        provider: 'bitbucket',
        url: 'https://bitbucket.org/owner/web/src/main',
      },
      notes: {
        provider: 'google-drive',
        remote: 'gdrive:client-notes',
        configFile: '/Users/me/.config/rclone/rclone.conf',
      },
      starter: {
        provider: 'github',
        url: 'https://gitbucket.example.com/owner/starter/tree/main',
      },
    },
  }),
);
```

Cloud storage uses the same `mounts` field. Credentials stay on the mount, not in the prompt.

```typescript
const workspace = await this.sandbox.openSandbox(
  createManifest({
    mounts: {
      room: {
        provider: 's3',
        bucket: 'account-files',
        region: 'us-east-1',
        prefix: 'northwind/',
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
      archive: {
        provider: 'gcs',
        bucket: 'account-archive',
        serviceAccountFile: '/Users/me/gcs.json',
      },
      assets: {
        provider: 'r2',
        bucket: 'assets',
        accountId: 'account-id',
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
      exports: {
        provider: 'azure',
        container: 'exports',
        accountName: 'account',
        accountKey: process.env.AZURE_ACCOUNT_KEY,
      },
      contracts: {
        provider: 'box',
        accessToken: process.env.BOX_ACCESS_TOKEN,
      },
    },
  }),
);
```

Cloud and Drive mounts attach only when the computer is Docker. `node:latest` does not include `git`, `rclone`, or FUSE, so build an image that does and pass it as `image`. Git hosts use `git`. Drive, S3, GCS, R2, Azure, and Box use `rclone`.

```dockerfile
FROM node:latest
RUN apt-get update \
  && apt-get install -y --no-install-recommends git rclone fuse3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
```

```typescript
const workspace = await this.sandbox.openSandbox(createManifest(), {
  computer: 'docker',
  image: 'agentic-sandbox',
});
```

Build that file with `docker build --tag agentic-sandbox .` before the call. A mount stays read-only. Pass `readOnly: false` only when the agent should write back to that bucket. Credentials stay on the mount or in the rclone config. Do not put them in the prompt.

### GitHub

1. For a public repo, paste the `https://github.com/owner/name` link. Add `/tree/<branch>` when the branch is not the default.
2. For a private repo, pass `token`. GitHub sends it as `x-access-token`, GitLab as `oauth2`, and Bitbucket as `x-token-auth` unless you set `username`. Use an https URL. An SSH URL cannot carry the token.

```typescript
const workspace = await this.sandbox.openSandbox(
  createManifest({
    repo: {
      url: 'https://github.com/owner/private',
      token: process.env.GITHUB_TOKEN,
    },
  }),
);
```

3. Open the workspace with the image above. The folder name is the repo name unless you set `path` on `repo`.

### GitLab

1. In the GitLab project, open Settings, then Access Tokens. Create a token with `read_repository`. For SSH, add your key under Preferences, then SSH Keys.
2. Copy the HTTPS or SSH clone URL. A branch link looks like `https://gitlab.com/group/api/-/tree/main`. Nested groups stay in the URL.
3. Pass it with `provider: 'gitlab'` and `token`. The app sends the token as `oauth2`.
4. Use an https URL. An SSH URL cannot carry the token.

### Bitbucket

1. In Bitbucket, open Personal settings, then App passwords. Create one with Repositories: Read. For SSH, add a key under SSH keys.
2. Copy the clone URL. A branch link looks like `https://bitbucket.org/owner/web/src/main`.
3. Pass it with `provider: 'bitbucket'`, `username`, and `token`. Without `username`, the app uses `x-token-auth`.
4. Use an https URL. An SSH URL cannot carry the token.

### GitBucket

1. GitBucket uses the same `/tree/<branch>` shape as GitHub. Pass that URL with `provider: 'github'`.
2. The host in the URL is your GitBucket server, for example `https://gitbucket.example.com/owner/starter/tree/main`.
3. Add that host to the machine's SSH known hosts or git credentials before the clone.

### Google Drive

1. On this Mac, install rclone: `brew install rclone`.
2. Run `rclone config`. Choose a new remote, name it `gdrive`, and choose Google Drive.
3. Follow the browser login. Leave the root folder empty unless you want one folder only.
4. The token is written to `~/.config/rclone/rclone.conf`. Pass that path as `configFile`. The file must be visible to the container.
5. Set `remote` to `gdrive:` for the whole drive, or `gdrive:client-notes` for one folder.
6. Open with `computer: 'docker'` and the image that contains rclone and fuse3.

### Amazon S3

1. In the AWS console, open IAM and create a user or role that can `s3:ListBucket` and `s3:GetObject` on one bucket. Add `s3:PutObject` only when `readOnly` is false.
2. Create an access key for that user. Copy the access key id and the secret.
3. Put them in the environment of this app, not in source. Pass `bucket`, `region`, `prefix`, `accessKeyId`, and `secretAccessKey` on the mount.
4. For a temporary STS key, also pass `sessionToken`. A custom endpoint uses `endpointUrl`. Amazon S3 Files is a separate mount: `provider: 's3-files'` and `fileSystemId`.
5. Open with the Docker image from above.

```typescript
mounts: {
  custom: {
    provider: 's3',
    bucket: 'account-files',
    endpointUrl: 'https://s3.example.com',
  },
  shared: {
    provider: 's3-files',
    fileSystemId: 'fs-0123456789abcdef0',
    region: 'us-east-1',
  },
},
```

### Google Cloud Storage

1. In Google Cloud, open IAM and create a service account. Grant it Storage Object Viewer on the bucket. Grant Storage Object Admin only when the agent should write.
2. Create a JSON key and save it outside the repo, for example `/Users/me/gcs.json`.
3. Pass `bucket` and `serviceAccountFile` with that path. The file must be visible to the container.
4. The other way is an HMAC key: pass `accessId` and `secretAccessKey` instead of the JSON file. To paste the JSON itself, pass `serviceAccountCredentials` with the file contents. `accessToken` is a third option when you already have a short-lived token.
5. Open with the Docker image from above.

### Cloudflare R2

1. In the Cloudflare dashboard, open R2, then Overview, and copy the Account ID.
2. Open Manage R2 API Tokens and create a token that can read the bucket. Allow write only when `readOnly` is false.
3. Copy the access key id and the secret.
4. Pass `accountId`, `bucket`, `accessKeyId`, and `secretAccessKey`.
5. Open with the Docker image from above.

### Azure Blob

1. In the Azure portal, open the storage account, then Access keys. Copy the storage account name and one key.
2. Open Containers and copy the container name. Create the container first if it does not exist.
3. Pass `provider: 'azure'`, `container`, `accountName`, and `accountKey`.
4. Open with the Docker image from above.

### Box

1. In the Box Developer Console, create an app and copy the client id and client secret. For a short test, the console can also issue a developer token.
2. Pass `accessToken` for that token, or pass `clientId` and `clientSecret`. For an enterprise app, also pass `boxSubType: 'enterprise'`, `impersonate` or `ownedBy`, and `rootFolderId`. `boxConfigFile` points at a Box config file, and `configCredentials` is that config as text.
3. A developer token expires quickly. Create a new one when the mount starts failing.
4. Open with the Docker image from above.

### Choose the computer

Unix is the default. Docker uses `node:latest`, so a new Node release arrives with the image and this file stays as it is. Pass `image` when a workspace needs a fixed tag.

Modal, Vercel, Cloudflare, E2B, Daytona, and Blaxel are installed with this app. Pass `computer` and the same agent. Cloudflare also needs `workerUrl` or `CLOUDFLARE_SANDBOX_WORKER_URL`. Each provider still reads its own credential: Modal uses `modal setup` or `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, E2B uses `E2B_API_KEY`, Daytona uses `DAYTONA_API_KEY`, Vercel uses `VERCEL_TOKEN`, and Blaxel uses its own workspace login.

```typescript
const workspace = await this.sandbox.openSandbox(createManifest(), {
  computer: 'modal',
});
```

```typescript
const workspace = await this.sandbox.openSandbox(createManifest(), {
  computer: 'cloudflare',
  workerUrl: 'https://sandbox.example.workers.dev',
});
```

```typescript
const workspace = await this.sandbox.openSandbox(createManifest(), {
  computer: 'docker',
  ports: [3000],
});

await this.sandbox.runSandbox('Start the site on port 3000.', agent, {
  workspace,
});

const preview = await this.sandbox.previewUrl(workspace, 3000);
```

### Self-hosted session

OpenAI runs this harness. `SandboxService` creates the session. This app keeps two keys.

`OPENAI_API_KEY` stays in this app. It creates the session and sends messages. Grant it Agents read, Agents write, and Responses write. Add Vaults read and write only when you store secrets in a vault.

`OPENAI_EXECUTOR_API_KEY` is the Codex environment key. `codex exec-server` reads it as `CODEX_API_KEY`. Agent-generated code can see that value, so it must not be the application key.

Get the Codex key:

1. Open the [OpenAI platform dashboard](https://platform.openai.com) for the same organization, project, and user or service account that will own the session.
2. Open the Agents tab and create an environment key.
3. Leave every permission at None except the one that connects environments, `api.agents.environments.connect`.
4. Copy the key into `.env` as `OPENAI_EXECUTOR_API_KEY` and restart this app.
5. Keep it out of source files, container images, and logs. Rotate or revoke it when it leaks.

If the organization has an IP allowlist, add the environment's outbound address. A general API key fails with `403 missing required scope api.agents.environments.connect`.

Install `@openai/codex@alpha` inside the environment, and allow outbound traffic to `https://api.openai.com` and `wss://codex-cloud-environments.chatgpt.com`.

```typescript
const session = await this.sandbox.createHostedSession(
  'Write clean code and verify that it works.',
  {
    workspaceDirectory: '/workspace',
    capabilityDirectories: ['/opt/skills'],
  },
);

const executor = this.sandbox.startHostedExecutor(session);
await this.sandbox.waitForHostedConnection(session.sessionId);
const answer = await this.sandbox.sendToHostedSession(
  session.sessionId,
  'Add a test for the homepage.',
);
```

On another machine, take the command and run it there after that machine is up:

```typescript
const command = this.sandbox.hostedExecutorCommand(session);
```

When OpenAI posts `agent.session.created` for a self-hosted session, this starts the executor on this Mac:

```typescript
this.sandbox.onHostedSessionCreated({
  type: 'agent.session.created',
  data: {
    environment_type: 'self_hosted',
    environment_id: session.environmentId,
    connect: { remote_url: session.remoteUrl },
  },
});
```

Store `session.sessionId` with the chat. One session needs its own executor. Use `remoteUrl` unchanged when the executor reconnects.

On this Mac, `startHostedExecutor` runs the executor. Set `REMOTE_MACHINE_PROVIDER` to `aws`, `digitalocean`, `databricks`, or `oci` when the webhook should create that machine instead. `POST /v1/sandbox/hosted-webhook` checks the OpenAI signature with `OPENAI_WEBHOOK_SECRET`. `agent.session.action_required` with `environment_connection` creates the machine. `agent.session.failed` deletes it.

1. In the OpenAI dashboard, add a webhook endpoint aimed at this route. Subscribe to `agent.session.action_required` and `agent.session.failed`.
2. Copy the signing secret into `OPENAI_WEBHOOK_SECRET` and restart.
3. For AWS, set `AWS_MICROVM_IMAGE_ARN`, `AWS_MICROVM_SECRET_ARN`, and the AWS CLI credentials. The image `/run` hook reads `environmentId`, `remoteUrl`, and `secretArn` from the payload.
4. For DigitalOcean, set `DIGITALOCEAN_TOKEN`. The app posts the `codex-agentapi` manifest to `/v2/agents/sessions` with `openai_session_id`.
5. For Databricks, set `DATABRICKS_HOST` to the workspace `https` URL and `DATABRICKS_TOKEN`. The app creates a sandbox and starts `codex exec-server` there. The key stays in the command environment.
6. For OCI, run `oci session authenticate --profile-name Sandbox --region <region>`, then set `OCI_SANDBOX_PROJECT_ID`, `OCI_SANDBOX_TOKEN`, and `OCI_SANDBOX_CREATE_URL` to the create URL in the current OCI sandbox guide. Preview releases can rename that URL. Delete calls that same URL plus the sandbox id.

</details>

<details>
<summary><h2>💚 Health checks</h2></summary>

- `GET /v1/health/live` proves that the process can answer requests.
- `GET /v1/health/ready` checks the process's memory limits.

Both routes also support API version 2. The checks do not depend on external websites, databases, or Redis.

</details>

<details>
<summary><h2>✅ Verification</h2></summary>

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
<summary><h2>🐳 Container deployment</h2></summary>

Build and run the same OCI image on Docker, Kubernetes, Nomad, ECS, Cloud Run, Fly.io, Railway, Render, or any compatible platform:

```bash
docker build --tag agentic:local .
docker run --rm --read-only --tmpfs /tmp --publish 3000:3000 agentic:local
```

The image uses pinned Bun and Node digests, contains production dependencies only, and runs as the unprivileged `node` user.

</details>

<details>
<summary><h2>🚀 CI/CD</h2></summary>

`.github/workflows/ci.yml` installs the lockfile exactly, checks formatting and types, runs all tests, audits dependencies, builds the application and container, and scans the runtime image. Every external action is pinned to a full commit SHA.

`.github/workflows/release.yml` verifies semantic-version tags, then publishes Linux AMD64 and ARM64 images to GitHub Container Registry. It creates an SBOM and signs a provenance attestation through GitHub OIDC. Configure protection rules and required reviewers on the repository's `production` environment before the first release.

Create a release with an immutable semantic version:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The workflow delivers a portable image. Each hosting platform can deploy that immutable image digest with its own native rollout and rollback controls.

</details>

<details>
<summary><h2>🛡️ Reliability and state</h2></summary>

> [!IMPORTANT]
> The HTTP API owns no durable state. A sandbox workspace lasts only while it stays open, until you save and resume it, or until a new workspace starts from its snapshot.

Add workflow and idempotency modules only with a shared production store and tested transaction boundaries. Until then, replicas can start, stop, and roll back without losing application-owned state because the application owns none.

The application enables graceful NestJS shutdown hooks. Its global exception filter also handles exceptions thrown by middleware, assigns a safe request ID, logs unexpected server errors, and keeps internal error details out of client responses.

</details>

## 📘 NestJS guidance applied

This project follows the current NestJS guidance for [exception filters](https://docs.nestjs.com/exception-filters), [security headers](https://docs.nestjs.com/techniques/security/cors), [CSRF protection](https://docs.nestjs.com/security/csrf), [validation](https://docs.nestjs.com/application/validation), [rate limiting](https://docs.nestjs.com/security/rate-limiting), and [shutdown hooks](https://docs.nestjs.com/fundamentals/lifecycle-events).

## ⭐ Acknowledgments

This Nestjs-OpenAI Agents SDK boilerplate was created by [Abolade Greatness](https://github.com/grtsnx).

Follow on [GitHub](https://github.com/grtsnx) and star [nestyagent](https://github.com/grtsnx/nestyagent).

- [X](https://x.com/grtsnx)
- [LinkedIn](https://www.linkedin.com/in/grtsnx)
- [grtsnx.com](https://grtsnx.com)
