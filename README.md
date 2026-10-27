# Agentic

Agentic is a ready-made NestJS app for building AI helpers with the OpenAI Agents SDK. It comes with versioned APIs, health checks, API docs, tidy responses, and error handling.

## 🍞 One story for every example

Every example in this guide is about one shop: **Sunny Bakery**.

| Name in the code | What it is                                                     |
| ---------------- | -------------------------------------------------------------- |
| `menuHelper`     | Answers questions about cakes, bread, and prices.              |
| `orderHelper`    | Looks after orders. It can cancel one.                         |
| `frontDesk`      | Reads every message first and passes it to the right helper.   |
| `bakeryHours`    | A tool. It tells a helper when the shop is open.               |
| `cancelOrder`    | A tool. It cancels an order, but only after a person says yes. |
| `siteHelper`     | Has its own computer and builds the bakery website.            |

A few words you will see a lot:

| Word         | Meaning                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| Agent        | A helper with one job.                                                          |
| Instructions | The helper's job description. You write it once.                                |
| Prompt       | The customer's message for one run.                                             |
| Tool         | Something a helper can do, like look up the opening hours.                      |
| Schema       | A form. The helper fills it in instead of writing free text.                    |
| Session      | The chat history, so the helper remembers earlier messages.                     |
| Guardrail    | A safety check on a message, an answer, or a tool.                              |
| Approval     | A pause where a person says yes or no before a tool runs.                       |
| Workspace    | A small computer the helper can use for files and commands.                     |
| Database     | Postgres. It keeps chats, waiting approvals, and machines safe across restarts. |

## 📋 Requirements

- Bun 1.3.14
- Node.js 24 or later to run in production
- Postgres 14 or later for chats, approvals, and self-hosted machines
- Docker, or another OCI container runtime, to deploy

<details>
<summary><h2>🛠️ Local development</h2></summary>

```bash
cp .env.example .env
bun install --frozen-lockfile
bun run db:migrate
bun run start:dev
```

`bun install` also builds the database client. `bun run db:migrate` creates the tables. It needs Postgres running at `DATABASE_URL`. For a quick local one:

```bash
docker run -d --name agentic-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=agentic -p 5432:5432 postgres:17-alpine
```

Swagger UI opens at `http://localhost:3000/api`. Scalar opens at `http://localhost:3000/docs`. The raw API documents are at `/api/v1-json` and `/api/v2-json`. The app prints every docs link when it starts.

</details>

<details>
<summary><h2>⚙️ Configuration</h2></summary>

The app checks these values before it starts. A bad port, a bad true/false value, or a bad CORS origin stops it.

| Variable                                                      | Default               | What it does                                                                                             |
| ------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                    | `development`         | Picks development, test, or production behavior.                                                         |
| `PORT`                                                        | `3000`                | The HTTP port.                                                                                           |
| `PLATFORM_NAME`                                               | `Agentic`             | The name shown on the API docs.                                                                          |
| `CORS_ORIGINS`                                                | empty                 | Browser sites allowed to call the API, separated by commas. Empty allows none.                           |
| `SWAGGER_ENABLED`                                             | on outside production | Turns the API docs on. Set it yourself in production.                                                    |
| `OBSERVE_ENABLED`                                             | `false`               | Turns on NestJS Observe.                                                                                 |
| `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET`, `OBSERVE_SERVICE_ID` | empty                 | NestJS Observe login. Needed when `OBSERVE_ENABLED` is on.                                               |
| `OPENAI_API_KEY`                                              | required              | Your OpenAI key. Every helper uses it. The app does not start without it.                                |
| `DATABASE_URL`                                                | empty                 | Your Postgres address. The app starts without it. Chats, saved approvals, and the webhook need it.       |
| `OPENAI_HOSTED_MODEL`                                         | `gpt-6-astra`         | The model for a self-hosted session when you do not pick one.                                            |
| `ACCOUNT_PASSWORD`                                            | empty                 | One login password the helper can use inside its computer. Empty means no password.                      |
| `OPENAI_EXECUTOR_API_KEY`                                     | empty                 | The small key for a self-hosted computer. See Self-hosted.                                               |
| `OPENAI_WEBHOOK_SECRET`                                       | empty                 | Proves a webhook really came from OpenAI. Empty rejects every webhook.                                   |
| `REMOTE_MACHINE_PROVIDER`                                     | `local`               | Where the webhook starts a self-hosted computer: `local`, `aws`, `digitalocean`, `databricks`, or `oci`. |

The AWS, DigitalOcean, Databricks, OCI, and Cloudflare settings are in `.env.example`. The Self-hosted and Choose the computer sections say when you need them.

> [!CAUTION]
> Never put `*` in `CORS_ORIGINS`. Write each full site address, like `https://sunnybakery.example`.

</details>

<details>
<summary><h2>🗄️ Database</h2></summary>

The app uses Postgres through Prisma. The database keeps three things, so they survive a restart and every copy of the app sees the same data:

| Table             | What it keeps                                       |
| ----------------- | --------------------------------------------------- |
| `chat_items`      | Every chat message, so a helper remembers the chat. |
| `paused_runs`     | Runs waiting for a person to say yes or no.         |
| `remote_machines` | Which self-hosted machine belongs to which session. |

The app only connects the first time one of these is used. Without `DATABASE_URL`, everything else still works.

| Command               | When to run it                                                    |
| --------------------- | ----------------------------------------------------------------- |
| `bun run db:migrate`  | On your machine, after you change `prisma/schema.prisma`.         |
| `bun run db:deploy`   | Applies new tables. The container already runs it when it starts. |
| `bun run db:generate` | Rebuilds the database client. `bun install` already does this.    |

You do not need a release step for the database. When the container starts with `DATABASE_URL` set, it applies any new migrations first, then starts the app. If a migration fails, the app does not start, so it never runs against the wrong tables. Two copies starting at once are safe: Postgres lets one migrate while the other waits.

</details>

<details>
<summary><h2>🤖 Helpers (agents)</h2></summary>

`OpenaiService` makes and runs helpers. You can inject it anywhere. It reads `OPENAI_API_KEY` once when the app starts.

### Make a helper

Give it a name and a job description.

```typescript
const menuHelper = this.openai.createAgent(
  'Menu helper',
  'You answer questions about Sunny Bakery cakes, bread, and prices.',
);
```

`model` is optional. Pass it to choose the model for this helper:

```typescript
const menuHelper = this.openai.createAgent(
  'Menu helper',
  'You answer questions about Sunny Bakery cakes, bread, and prices.',
  { model: 'gpt-6-astra' },
);
```

### Ask it a question

```typescript
const result = await this.openai.runAgent(
  'Do you have a chocolate cake?',
  menuHelper,
);

result.finalOutput; // "Yes! Our chocolate cake is $25."
```

### Give it a tool

A tool is a small function the helper can call. Here the helper can look up the opening hours.

```typescript
import { tool } from '@openai/agents';
import { z } from 'zod';

const bakeryHours = tool({
  name: 'bakery_hours',
  description: 'Tell the customer when Sunny Bakery is open.',
  parameters: z.object({}),
  async execute() {
    return 'Open every day from 7am to 6pm.';
  },
});

const menuHelper = this.openai.createAgent(
  'Menu helper',
  'You answer questions about Sunny Bakery cakes, bread, and prices.',
  { tools: [bakeryHours] },
);
```

Keep your own tools in `src/config/tools`. `sample.tool.ts` there is a starting template.

### Get a filled-in form back

Pass a `schema` when you want a form instead of free text. The result has the same shape as the form.

```typescript
const orderSchema = z.object({
  item: z.string(),
  quantity: z.number(),
  pickupDay: z.string(),
});

const orderReader = this.openai.createAgent(
  'Order reader',
  'Turn the customer message into an order.',
  { schema: orderSchema },
);

const result = await this.openai.runAgent(
  'Two croissants for Saturday, please.',
  orderReader,
);

result.finalOutput; // { item: 'croissant', quantity: 2, pickupDay: 'Saturday' }
```

Without a schema, `finalOutput` is text. `src/config/schema/sample.schema.ts` holds this same order form as `sampleSchema`, so you can import it with `import { sampleSchema } from '@/config/schema'`. Keep your own schemas there too.

### Pass your own data

`context` is data for your code, like the customer id. The model never sees it. Your tools can read it.

```typescript
const result = await this.openai.runAgent('Where is my order?', orderHelper, {
  context: { customerId: 'c-42' },
});
```

### Remember the chat

`createSession` makes a chat history. Pass the same one on every message, and the helper remembers what was said. It is kept in Postgres, so it survives a restart and works on every copy of the app.

```typescript
const chat = this.openai.createSession('chat-c-42');

await this.openai.runAgent('I ordered a birthday cake.', orderHelper, {
  session: chat,
});

const result = await this.openai.runAgent(
  'When can I pick it up?',
  orderHelper,
  { session: chat },
);
```

The second message works because the helper remembers the cake.

Give each chat its own id, like the customer's chat id, and store it. Pass that id again tomorrow and the chat carries on. With no id, `createSession()` makes a new random one, which you can read with `await chat.getSessionId()`.

### Pick the model

**One model for everyone.** `createRunner` sets a fallback model. A helper without its own `model` uses it. Call it once when the app starts, because it changes every later run.

```typescript
this.openai.createRunner('gpt-6-astra');

const menuHelper = this.openai.createAgent(
  'Menu helper',
  'You answer questions about Sunny Bakery cakes, bread, and prices.',
); // uses gpt-6-astra

const orderHelper = this.openai.createAgent(
  'Order helper',
  'You track and cancel Sunny Bakery orders.',
  { model: 'gpt-5.6-terra' },
); // keeps gpt-5.6-terra
```

**How hard it thinks.** `modelSettings` is optional. Without it, the model decides on its own.

```typescript
const menuHelper = this.openai.createAgent(
  'Menu helper',
  'You answer questions about Sunny Bakery cakes, bread, and prices.',
  { modelSettings: { reasoning: { effort: 'low' } } },
);
```

**How creative it writes.** `temperature` is optional. `0` gives the same wording every time. `1` lets it change.

```typescript
const menuHelper = this.openai.createAgent(
  'Menu helper',
  'You answer questions about Sunny Bakery cakes, bread, and prices.',
  { model: 'gpt-5.6-terra', temperature: 0.7 },
);
```

> [!WARNING]
> `gpt-6-astra` does not accept `temperature`. Leave it out for that model.

### Stop a run, or limit its steps

`signal` stops a run, for example when the customer closes the page. `maxTurns` stops a helper that goes round in circles. Both are optional, and `resumeAgent` takes them too.

```typescript
const controller = new AbortController();
request.on('close', () => controller.abort());

const result = await this.openai.runAgent('Where is my order?', orderHelper, {
  signal: controller.signal,
  maxTurns: 5,
});
```

### Faster long jobs

Turn on `websocket` when one message makes the helper work in many steps, like call a tool, think, then call another tool. A quick question does not need it.

```typescript
const result = await this.openai.runAgent(
  'Check my three orders and tell me which is ready.',
  orderHelper,
  { session: chat, websocket: true },
);
```

### A front desk that passes work on

Start with one helper. Add more only when a job needs its own instructions, tools, or rules.

When you do, give each helper a `handoffDescription`. That one line tells the front desk when to pass work to it. Then make the front desk with `createTriageAgent`.

```typescript
const menuHelper = this.openai.createAgent(
  'Menu helper',
  'You answer questions about Sunny Bakery cakes, bread, and prices.',
  { handoffDescription: 'Questions about the menu and prices' },
);

const orderHelper = this.openai.createAgent(
  'Order helper',
  'You track and cancel Sunny Bakery orders.',
  { handoffDescription: 'Questions about an existing order' },
);

const frontDesk = this.openai.createTriageAgent(
  'Front desk',
  'Read the message and pass it to the right helper.',
  [menuHelper, orderHelper],
  'Greets every Sunny Bakery customer',
);

const result = await this.openai.runAgent('Where is my order?', frontDesk);
```

The front desk passes "Where is my order?" to `orderHelper`, and `orderHelper` answers.

To give one handoff its own name or settings, wrap that helper in `handoff`:

```typescript
import { handoff } from '@openai/agents';

const frontDesk = this.openai.createTriageAgent(
  'Front desk',
  'Read the message and pass it to the right helper.',
  [menuHelper, handoff(orderHelper, { toolNameOverride: 'order_desk' })],
  'Greets every Sunny Bakery customer',
);
```

### Keep talking to the same helper

After the front desk passes a chat on, `nextAgent` gives you the helper who answered. Send the next message to that helper. If nobody took over, you get the front desk back.

```typescript
const chat = this.openai.createSession();

const first = await this.openai.runAgent('Where is my order?', frontDesk, {
  session: chat,
});

const helper = this.openai.nextAgent(first, frontDesk); // orderHelper

await this.openai.runAgent('It was a birthday cake.', helper, {
  session: chat,
});
```

Send every message to `frontDesk` instead when each one should be sorted again.

### One customer, start to finish

`reply` runs one message. Pass the same `session` so the chat is remembered. `fallback` is optional. `turn.helper` is who should take the next message. `turn.output` is the answer.

When a tool pauses, `turn.waiting` is true and `turn.output` is empty. `finish(turn, 'approve')` or `finish(turn, 'reject')` continues that same run. `message` on a rejection is optional.

```typescript
const chat = this.openai.createSession();

const orderHelper = this.openai.createAgent(
  'Order helper',
  'You track and cancel Sunny Bakery orders.',
  {
    handoffDescription: 'Questions about an existing order',
    tools: [cancelOrder],
  },
);

const frontDesk = this.openai.createTriageAgent(
  'Front desk',
  'Read the message and pass it to the right helper.',
  [orderHelper],
  'Greets every Sunny Bakery customer',
);

let turn = await this.openai.reply('Where is my birthday cake?', frontDesk, {
  session: chat,
  fallback: frontDesk,
});

turn.output; // the order helper's reply
turn.helper; // orderHelper

turn = await this.openai.reply('Cancel it. It is order 123.', turn.helper, {
  session: chat,
  fallback: frontDesk,
});

if (turn.waiting) {
  turn = await this.openai.finish(turn, 'approve');
}

turn.output; // "Order 123 is cancelled."
```

Say no instead with `this.openai.finish(turn, 'reject', { message: 'The cake is already baked.' })`.

### Use a helper as a tool

Sometimes one helper should do a small job for another and hand the result back, instead of taking over the chat. `asTool` does that. The main helper still writes the answer.

```typescript
const readOrder = this.openai.asTool(orderReader, {
  toolName: 'read_order',
  toolDescription: 'Turn a message into an order form.',
});

const frontDesk = this.openai.createAgent(
  'Front desk',
  'Help the customer. Use read_order when they want to buy something.',
  { tools: [readOrder] },
);

await this.openai.runAgent('Two croissants for Saturday, please.', frontDesk);
```

`toolName` and `toolDescription` are optional. Without `toolName`, the tool is named after the helper: `this.openai.asTool(orderReader)`.

</details>

<details>
<summary><h2>🚧 Safety checks (guardrails)</h2></summary>

A guardrail is a safety check. Every check here is optional. Leave them out when you do not need them.

| Check         | When it runs                                       |
| ------------- | -------------------------------------------------- |
| Message check | Before the first helper works on the message.      |
| Answer check  | On the final answer, from the helper who wrote it. |
| Tool check    | Right before or right after one tool runs.         |
| Approval      | Pauses a tool until a person says yes or no.       |

### Check the message

This stops messages that are not about the bakery. When the check says stop, the run throws an error and the helper does not answer.

```typescript
const bakeryOnly = this.openai.inputGuardrail(
  'Bakery only',
  async ({ input }) => {
    const text = typeof input === 'string' ? input : '';
    const offTopic = text.includes('homework');
    return { tripwireTriggered: offTopic, outputInfo: { offTopic } };
  },
);

const frontDesk = this.openai.createTriageAgent(
  'Front desk',
  'Read the message and pass it to the right helper.',
  [menuHelper, orderHelper],
  'Greets every Sunny Bakery customer',
  { inputGuardrails: [bakeryOnly] },
);
```

- `tripwireTriggered: true` means stop.
- The helper waits for the check. So a stopped message never reaches a tool like `cancelOrder`.
- `runInParallel: true` runs the check and the helper at the same time. It is faster, but the helper may already have used a tool when the check says stop. Only use it for helpers whose tools change nothing.
- A message check only runs on the **first** helper. Put it on `frontDesk`, not on `menuHelper`.
- `createAgent` and `createSandboxAgent` take the same `inputGuardrails` list.

### Check the message with a helper

A keyword is easy to fool. You can ask a small helper to judge instead. Its answer goes to `tripwire`, which returns `true` to stop.

```typescript
const topicChecker = this.openai.createAgent(
  'Topic checker',
  'Decide if the message is about Sunny Bakery.',
  { schema: z.object({ aboutBakery: z.boolean() }) },
);

const bakeryOnly = this.openai.agentInputGuardrail(
  'Bakery only',
  topicChecker,
  (answer) => answer?.aboutBakery === false,
);
```

### Check the answer

This stops an answer before the customer sees it. It runs on the helper that writes the final answer. After a handoff, that is the helper who took over.

```typescript
const keepRecipeSecret = this.openai.outputGuardrail(
  'Keep the recipe secret',
  async ({ agentOutput }) => ({
    tripwireTriggered: String(agentOutput).includes('secret recipe'),
    outputInfo: null,
  }),
);

const menuHelper = this.openai.createAgent(
  'Menu helper',
  'You answer questions about Sunny Bakery cakes, bread, and prices.',
  { outputGuardrails: [keepRecipeSecret] },
);
```

### Check a tool

A tool check sits on the tool itself, so it works no matter which helper calls it. This one makes sure the order number is real.

```typescript
const realOrderNumber = this.openai.toolInputGuardrail(
  'Real order number',
  async ({ toolCall }) => {
    const { orderId } = JSON.parse(toolCall.arguments) as { orderId?: number };
    if (orderId && orderId > 0) return this.openai.allowTool();
    return this.openai.rejectTool('Please give a real order number.');
  },
);
```

A tool check returns one of three answers:

- `allowTool()` lets the tool run.
- `rejectTool(message)` skips the tool and tells the helper why.
- `stopTool()` stops the whole run.

`toolOutputGuardrail` works the same way, but checks what the tool returned.

### Ask a person first (approval)

`needsApproval: true` pauses the tool until a person says yes or no.

```typescript
const cancelOrder = tool({
  name: 'cancel_order',
  description: 'Cancel a Sunny Bakery order.',
  parameters: z.object({ orderId: z.number() }),
  needsApproval: true,
  inputGuardrails: [realOrderNumber],
  async execute({ orderId }) {
    return `Order ${orderId} is cancelled.`;
  },
});

const orderHelper = this.openai.createAgent(
  'Order helper',
  'You track and cancel Sunny Bakery orders.',
  { tools: [cancelOrder] },
);
```

Pass a function instead of `true` to pause only some calls. This one asks only for big orders:

```typescript
needsApproval: async (_context, { orderId }) => orderId > 1000,
```

A helper used as a tool can pause the same way:

```typescript
const readOrder = this.openai.asTool(orderReader, {
  toolName: 'read_order',
  needsApproval: async (_context, { input }) => input.includes('wedding'),
});
```

### Say yes or no, then carry on

When a tool pauses, `result.interruptions` lists what is waiting. Say yes with `approve`, or no with `reject`. Then `resumeAgent` carries on from the same spot. It does not start over.

```typescript
let result = await this.openai.runAgent('Cancel order 123.', orderHelper);

if (result.interruptions?.length) {
  const state = this.openai.approve(result);
  result = await this.openai.resumeAgent(orderHelper, state);
}
```

Say no, with a reason the helper will see:

```typescript
const state = this.openai.reject(result, {
  message: 'The cake is already baked.',
});
result = await this.openai.resumeAgent(orderHelper, state);
```

Options, all optional:

- `interruptions` picks which pauses to decide. Leave it out to decide all of them.
- `alwaysApprove: true` says yes to that tool for the rest of the run.
- `alwaysReject: true` says no to that tool for the rest of the run.

> [!TIP]
> Make tools that change things safe to run twice. Cancelling order 123 when it is already cancelled should do nothing. Then a retry can never cancel two things.

### Decide later

A person may not answer right away. `saveRun` keeps the paused run in Postgres and gives you an id. Load it later with that id. It is still the same run, even after a restart.

```typescript
const runId = await this.openai.saveRun(result); // keep this id

// later, maybe in another request
const state = await this.openai.loadRun(orderHelper, runId);
this.openai.approve({ state });
const finished = await this.openai.resumeAgent(orderHelper, state);
```

- Load it with the same helper that started the run.
- A run can be loaded **once**. If the owner clicks "Yes" twice, the second load throws, so the order is never cancelled twice.
- If the run does not fit the helper, nothing is taken. It stays waiting.

### Streaming

`stream: true` sends the answer piece by piece. Pauses work the same way: wait for `completed`, then decide and carry on.

```typescript
const streamed = await this.openai.runAgent('Cancel order 123.', orderHelper, {
  stream: true,
});

await streamed.completed;

if (streamed.interruptions?.length) {
  const state = this.openai.approve(streamed);
  await this.openai.resumeAgent(orderHelper, state);
}
```

> [!WARNING]
> With `stream: true`, the customer sees words as they are written. An answer check only runs at the end. So the customer may see words the check later stops. Do not stream from a helper whose answer check matters, like `keepRecipeSecret`.

`outputGuardrailBlockedMessage` is optional on `runAgent` and `resumeAgent`. When an answer check blocks a tool's result, the SDK keeps a short note in its place. This option sets that note's text.

### Know which check said stop

A blocked run throws an error. `guardrailTripwire` tells you which kind of check stopped it: `input`, `output`, `tool-input`, or `tool-output`. For any other error it returns `undefined`.

```typescript
try {
  await this.openai.runAgent('Do my math homework.', frontDesk);
} catch (error) {
  const stoppedBy = this.openai.guardrailTripwire(error); // 'input'
  if (stoppedBy) return 'Sorry, I can only help with the bakery.';
  throw error;
}
```

</details>

<details>
<summary><h2>💻 Sandbox (a helper with its own computer)</h2></summary>

`SandboxService` gives a helper a small computer, called a workspace. The helper can make files, run commands, and use a browser there. In this guide, `siteHelper` uses one to build the Sunny Bakery website.

Every sandbox helper can already:

- `shell`: run commands.
- `filesystem`: read and edit files.
- `compaction`: shorten a long job so it can keep going.

`skills` and `memory` are extra. See below.

### Make the site helper

```typescript
const siteHelper = this.sandbox.createSandboxAgent(
  'Site helper',
  'You build and update the Sunny Bakery website.',
);
```

It takes the same `model`, `handoffDescription`, `inputGuardrails`, and `outputGuardrails` options as `createAgent`.

### Put files on the computer

`createManifest` lists what the computer starts with. Give the list to `openSandbox`.

An empty computer:

```typescript
import { createManifest } from '@/config/workspace';

const workspace = await this.sandbox.openSandbox(createManifest());
```

A computer with the website files:

```typescript
const workspace = await this.sandbox.openSandbox(
  createManifest({
    files: {
      'site/index.html': '<h1>Sunny Bakery</h1>',
      'site/styles.css': 'body { font-family: sans-serif; }',
      'notes/todo.md': 'Add the cake menu to the homepage.',
    },
  }),
);
```

Start from a GitHub project:

```typescript
const workspace = await this.sandbox.openSandbox(
  createManifest({ repo: 'https://github.com/sunny-bakery/website' }),
);
```

`repo` can be `owner/name`, a GitHub link, or a `git@github.com:...` address. Add `/tree/<branch>` to the link for a branch. `path` changes the folder name:

```typescript
createManifest({
  repo: {
    url: 'https://github.com/sunny-bakery/website/tree/main',
    path: 'site',
  },
});
```

Everything `createManifest` takes:

| Option        | What it adds                                                  |
| ------------- | ------------------------------------------------------------- |
| `files`       | Text files you write in the code.                             |
| `localFiles`  | Files copied from this machine.                               |
| `localDirs`   | Folders copied from this machine.                             |
| `outputDirs`  | Empty folders, like `output`.                                 |
| `repo`        | A git project to clone.                                       |
| `mounts`      | Cloud storage, Google Drive, or more git projects. See below. |
| `users`       | Accounts on the computer.                                     |
| `groups`      | Groups of those accounts.                                     |
| `environment` | Plain startup values, like a site address.                    |
| `entries`     | Raw SDK entries, only if the options above are not enough.    |

```typescript
createManifest({
  localDirs: { photos: '/Users/me/bakery/photos' },
  localFiles: { 'menu.pdf': '/Users/me/bakery/menu.pdf' },
  outputDirs: ['output'],
  users: ['baker'],
  groups: [{ name: 'staff', users: ['baker'] }],
  environment: { SITE_URL: 'https://sunnybakery.example' },
});
```

### Give it a job

`runSandbox` runs the helper on that computer.

```typescript
const result = await this.sandbox.runSandbox(
  'Add the cake menu to the homepage.',
  siteHelper,
  { workspace },
);
```

### Keep working on the same computer

Pass the same `workspace` again and the files are still there. Pass a `chat` too and the helper remembers the conversation.

```typescript
const chat = this.openai.createSession();

await this.sandbox.runSandbox('Add the cake menu.', siteHelper, {
  workspace,
  chat,
});

await this.sandbox.runSandbox('Make the prices bigger.', siteHelper, {
  workspace,
  chat,
});
```

### Read a file back

```typescript
const html = await this.sandbox.readWorkspaceFile(workspace, 'site/index.html');
```

### Save, close, and come back later

1. Save the computer with `saveSandbox`.
2. Close it with `closeSandbox`.
3. Bring it back with `resumeSandbox`.

```typescript
const workspace = await this.sandbox.openSandbox(createManifest(), {
  snapshotDir: '/tmp/bakery-snapshots',
});

const saved = await this.sandbox.saveSandbox(workspace, {
  snapshotDir: '/tmp/bakery-snapshots',
});
await this.sandbox.closeSandbox(workspace);

const again = await this.sandbox.resumeSandbox(saved, {
  snapshotDir: '/tmp/bakery-snapshots',
});
```

Give `saveSandbox` and `resumeSandbox` the **same** options you gave `openSandbox`: the same `computer`, `client`, and `snapshotDir`. A Modal computer saved without `computer: 'modal'` cannot come back.

> [!WARNING]
> `snapshotDir` is a folder on this machine. The production container has a read-only disk and an empty `/tmp` after each restart, so snapshots there are lost. In production, mount a lasting volume for `snapshotDir`, or use a cloud computer such as Modal or E2B, which keeps its own snapshots.

### Quick one-off job

`runSandboxOnce` makes a computer, does the job, and throws the computer away. It takes the same options as `openSandbox`.

```typescript
const result = await this.sandbox.runSandboxOnce(
  'Check the homepage for spelling mistakes.',
  siteHelper,
  {
    manifest: createManifest({
      files: { 'index.html': '<h1>Suny Bakery</h1>' },
    }),
  },
);
```

To start every one-off job from the same files, give the helper a `manifest`:

```typescript
const siteHelper = this.sandbox.createSandboxAgent(
  'Site helper',
  'You build and update the Sunny Bakery website.',
  {
    manifest: createManifest({
      files: { 'site/index.html': '<h1>Sunny Bakery</h1>' },
    }),
  },
);

await this.sandbox.runSandboxOnce('Add a footer.', siteHelper);
```

### Let the front desk use the site helper

`this.sandbox.asTool` turns `siteHelper` into a tool. Pass `workspace` to keep using the same computer. Leave it out to get a fresh computer each time. Unlike `this.openai.asTool`, it returns a promise, so `await` it.

```typescript
const updateSite = await this.sandbox.asTool(siteHelper, {
  toolName: 'update_site',
  toolDescription: 'Change the Sunny Bakery website.',
  workspace,
  needsApproval: true,
});

const frontDesk = this.openai.createAgent(
  'Front desk',
  'Help the owner. Use update_site for website changes.',
  { tools: [updateSite] },
);

await this.openai.runAgent('Put the new cupcake on the homepage.', frontDesk);
```

`needsApproval` is optional. Here a person approves every website change.

### Skills

A skill is a folder with a `SKILL.md` file of extra instructions. Pick **one** way to load skills.

Write the skill in the code:

```typescript
const siteHelper = this.sandbox.createSandboxAgent(
  'Site helper',
  'Follow the review skill before you publish a page.',
  {
    skills: {
      skills: [
        {
          name: 'review',
          description: 'Review a page before publishing it.',
          content: '# Review\n\nCheck the prices, then the links.',
        },
      ],
    },
  },
);
```

Load every skill from a GitHub project, where each top folder holds a `SKILL.md`:

```typescript
import { gitRepo } from '@openai/agents/sandbox';

skills: {
  from: gitRepo({ repo: 'https://github.com/sunny-bakery/skills', ref: 'main' }),
},
```

If the skills sit in a subfolder, add `subpath: 'skills'` to `gitRepo`. A skills.sh page is only a list. Copy the GitHub link it shows and pass that to `gitRepo`.

Load a skill only when the helper asks for it:

```typescript
skills: {
  lazyFrom: {
    source: gitRepo({ repo: 'https://github.com/sunny-bakery/skills' }),
    index: [
      { name: 'review', description: 'Review a page before publishing it.', path: 'review' },
    ],
  },
},
```

### Memory

`memory: true` lets the helper write down lessons after a job and read them next time.

```typescript
const siteHelper = this.sandbox.createSandboxAgent(
  'Site helper',
  'Remember the bakery colors and fonts. Never store passwords.',
  { memory: true },
);
```

More choices:

| You want                       | Pass                                                                   |
| ------------------------------ | ---------------------------------------------------------------------- |
| Read old lessons, write none   | `memory: { read: true, generate: false }`                              |
| Write lessons, ignore old ones | `memory: { read: false, generate: true }`                              |
| Tell it what to remember       | `memory: { generate: { extraPrompt: 'Remember the bakery colors.' } }` |
| Two helpers, separate notes    | `memory: { layout: { directory: 'memories/site-helper' } }`            |

Lessons live in the `memories/` folder. They last while the computer stays open, when you resume it, or when a new computer starts from its snapshot. `closeSandbox` writes them down before the computer stops.

### A password for logging in

The helper may need to log in to a website, like the bakery's shop admin page. This app gives it one password. The password is never put in a prompt.

1. Put the password in `.env`:

```bash
ACCOUNT_PASSWORD=the-shop-admin-password
```

2. Restart the app.
3. Call `openSandbox`. It copies the password into the computer as `$ACCOUNT_PASSWORD`.
4. The helper reads `$ACCOUNT_PASSWORD` when a login form asks for it.

> [!WARNING]
> A saved computer does not keep the password. It comes from `.env` again when you open or resume.

Empty `ACCOUNT_PASSWORD` means no password. For one computer with a different password, pass `password`:

```typescript
const workspace = await this.sandbox.openSandbox(createManifest(), {
  password: this.owner.shopPassword,
});
```

### Mount git projects, Google Drive, or cloud storage

`mounts` adds outside things as folders.

```typescript
const workspace = await this.sandbox.openSandbox(
  createManifest({
    mounts: {
      website: {
        provider: 'github',
        url: 'https://github.com/sunny-bakery/website',
        ref: 'main',
      },
      api: {
        provider: 'gitlab',
        url: 'https://gitlab.com/sunny-bakery/api/-/tree/main',
      },
      shop: {
        provider: 'bitbucket',
        url: 'https://bitbucket.org/sunny-bakery/shop/src/main',
      },
      menus: {
        provider: 'google-drive',
        remote: 'gdrive:bakery-menus',
        configFile: '/Users/me/.config/rclone/rclone.conf',
      },
      photos: {
        provider: 's3',
        bucket: 'sunny-bakery-photos',
        region: 'us-east-1',
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    },
  }),
  { computer: 'docker', image: 'bakery-sandbox' },
);
```

Two kinds of mounts:

- **Git projects** (`github`, `gitlab`, `bitbucket`) are copied, not attached. The SDK clones them on **this** machine, then copies them in. They work on any computer. This machine needs `git`.
- **Storage** (Google Drive, S3, GCS, R2, Azure, Box) is attached live with `rclone`. It only works on a **Docker** computer whose image has `rclone` and `fuse3`:

```dockerfile
FROM node:latest
RUN apt-get update \
  && apt-get install -y --no-install-recommends rclone fuse3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
```

Build it with `docker build --tag bakery-sandbox .`, then pass `image: 'bakery-sandbox'`.

Storage is read-only unless you pass `readOnly: false`. Keep keys on the mount or in the rclone config. Never put them in a prompt.

### Private git projects

1. Make a read-only token on the git site.
2. Pass it as `token`. Use an `https` link. A `git@` link cannot carry a token.

```typescript
createManifest({
  repo: {
    url: 'https://github.com/sunny-bakery/private-site',
    token: process.env.GITHUB_TOKEN,
  },
});
```

The token is never written into the link. It stays out of saved computers, snapshots, `.git/config`, and error messages. A Unix computer shares this app's environment and could still read it, so use Docker or a hosted computer for code you do not trust.

| Site      | Where to make the token                                         | Notes                                                                                          |
| --------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| GitHub    | Settings, then Developer settings, then Personal access tokens. | Sent as `x-access-token`.                                                                      |
| GitLab    | Project Settings, then Access Tokens, with `read_repository`.   | Sent as `oauth2`. A branch link looks like `/-/tree/main`.                                     |
| Bitbucket | Personal settings, then App passwords, with Repositories: Read. | Pass `username` too. Without it, `x-token-auth` is used. A branch link looks like `/src/main`. |
| GitBucket | Your GitBucket server.                                          | Use `provider: 'github'`. Add the server to this machine's git login first.                    |

### Storage setup

All of these need the Docker image above.

| Storage         | Steps                                                                                                                                                   | Pass on the mount                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Google Drive    | `brew install rclone`, run `rclone config`, add a Google Drive remote named `gdrive`, and log in. The login is saved in `~/.config/rclone/rclone.conf`. | `provider: 'google-drive'`, `remote`, `configFile`                                                                                         |
| Amazon S3       | In IAM, allow `s3:ListBucket` and `s3:GetObject` on one bucket, plus `s3:PutObject` to write. Make an access key.                                       | `bucket`, `region`, `accessKeyId`, `secretAccessKey`. Optional: `prefix`, `sessionToken`, `endpointUrl`                                    |
| Amazon S3 Files | A separate file system.                                                                                                                                 | `provider: 's3-files'`, `fileSystemId`, `region`                                                                                           |
| Google Cloud    | Make a service account with Storage Object Viewer, plus Admin to write. Download a JSON key.                                                            | `bucket`, `serviceAccountFile`. Or `accessId` and `secretAccessKey`, `serviceAccountCredentials`, or `accessToken`                         |
| Cloudflare R2   | Copy the Account ID. Make an R2 API token that can read the bucket.                                                                                     | `accountId`, `bucket`, `accessKeyId`, `secretAccessKey`                                                                                    |
| Azure Blob      | Copy the storage account name, one access key, and the container name.                                                                                  | `provider: 'azure'`, `container`, `accountName`, `accountKey`                                                                              |
| Box             | Make an app in the Box Developer Console. A developer token works for a short test.                                                                     | `accessToken`, or `clientId` and `clientSecret`. For a company app: `boxSubType: 'enterprise'`, `impersonate` or `ownedBy`, `rootFolderId` |

### Choose the computer

| `computer`                                                  | What it is                                               |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `unix` (default)                                            | Runs on this machine.                                    |
| `docker`                                                    | A container. Uses `node:latest` unless you pass `image`. |
| `modal`, `vercel`, `cloudflare`, `e2b`, `daytona`, `blaxel` | A computer in the cloud. Each reads its own login.       |

Cloud logins: Modal uses `modal setup` or `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`. E2B uses `E2B_API_KEY`. Daytona uses `DAYTONA_API_KEY`. Vercel uses `VERCEL_TOKEN`. Blaxel uses its own login. Cloudflare needs `workerUrl` or `CLOUDFLARE_SANDBOX_WORKER_URL`, plus `CLOUDFLARE_SANDBOX_API_KEY` if the worker checks a key.

```typescript
const workspace = await this.sandbox.openSandbox(createManifest(), {
  computer: 'modal',
});
```

### See the website

Open a port, ask the helper to start the site, then get a link to it.

```typescript
const workspace = await this.sandbox.openSandbox(createManifest(), {
  computer: 'docker',
  ports: [3000],
});

await this.sandbox.runSandbox(
  'Start the bakery site on port 3000.',
  siteHelper,
  {
    workspace,
  },
);

const link = await this.sandbox.previewUrl(workspace, 3000);
```

</details>

<details>
<summary><h2>🖥️ Self-hosted (OpenAI runs the helper, you run the computer)</h2></summary>

Here OpenAI runs the helper, and the computer is yours. A small program called the executor runs on your computer and does the work OpenAI asks for.

### Two keys

| Key                       | Lives in      | Allowed to                                                                                              |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`          | This app only | Agents read, Agents write, Responses write. Add Vaults read and write only if you use vaults.           |
| `OPENAI_EXECUTOR_API_KEY` | Your computer | Only `api.agents.environments.connect`. Code on that computer can see it, so it must be this small key. |

Get the small key:

1. Open the [OpenAI platform dashboard](https://platform.openai.com). Use the same organization, project, and user as the session.
2. Open the Agents tab and make an environment key.
3. Set every permission to None except `api.agents.environments.connect`.
4. Put it in `.env` as `OPENAI_EXECUTOR_API_KEY` and restart.
5. Keep it out of code, images, and logs. Replace it if it leaks.

A normal API key fails here with `403 missing required scope api.agents.environments.connect`. If your organization only allows some IP addresses, add your computer's address.

On your computer, install `@openai/codex@alpha` and allow outgoing traffic to `https://api.openai.com` and `wss://codex-cloud-environments.chatgpt.com`.

### Run it on this machine

```typescript
const session = await this.sandbox.createHostedSession(
  'You build and test the Sunny Bakery website.',
  { workspaceDirectory: '/workspace' },
);

const executor = await this.sandbox.connectHostedSession(session);

const answer = await this.sandbox.sendToHostedSession(
  session.sessionId,
  'Add a test for the homepage.',
);
```

`connectHostedSession` does three things in order:

1. Starts listening for news about the session.
2. Starts the executor on this machine.
3. Waits until the executor is connected.

If it fails or takes more than two minutes, it stops the executor and throws. Pass a number of milliseconds as the second argument to wait longer.

The executor only gets `CODEX_API_KEY` and the basics (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `SHELL`). It cannot see `OPENAI_API_KEY` or your other keys.

Save `session.sessionId` with the chat. Each session needs its own executor.

### Run it on another machine

Start listening first, then start the other machine inside `onListening`:

```typescript
const command = this.sandbox.hostedExecutorCommand(session);

await this.sandbox.waitForHostedConnection(session.sessionId, {
  onListening: () => startBakeryMachine(command),
});
```

`startBakeryMachine` is your own code that runs `command` on that machine.

### Let a webhook start the machine for you

OpenAI can call this app when a session needs a computer. The app then makes one, and deletes it when the session fails or its computer expires.

1. In the OpenAI dashboard, add a webhook pointing at `POST /v1/webhook`. Pick these events: `agent.session.action_required`, `agent.session.failed`, and `agent.environment.expired`.
2. Put the signing secret in `OPENAI_WEBHOOK_SECRET` and restart.
3. Set `REMOTE_MACHINE_PROVIDER` to where the computer should run:

| Provider       | Set up                                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`        | Nothing. The executor starts on this machine.                                                                                                                                             |
| `aws`          | `AWS_MICROVM_IMAGE_ARN`, `AWS_MICROVM_SECRET_ARN`, and AWS CLI login. The image's `/run` hook reads `environmentId`, `remoteUrl`, and `secretArn`.                                        |
| `digitalocean` | `DIGITALOCEAN_TOKEN`.                                                                                                                                                                     |
| `databricks`   | `DATABRICKS_HOST` (an `https` address) and `DATABRICKS_TOKEN`. The computer is named after the session, so a retry reuses it.                                                             |
| `oci`          | Run `oci session authenticate --profile-name Sandbox --region <region>`. Then set `OCI_SANDBOX_PROJECT_ID`, `OCI_SANDBOX_TOKEN`, and `OCI_SANDBOX_CREATE_URL` from the current OCI guide. |

The webhook needs `DATABASE_URL`. It keeps one row per session in the `remote_machines` table.

Safe if things go wrong:

- **Same webhook twice, or two servers:** each tries to add the session's row. The database lets only one add it, so only one machine gets made.
- **The machine fails to start:** the row is removed and the app answers with an error, so OpenAI tries again.
- **The machine id cannot be saved:** the machine is deleted, so nothing runs that nobody knows about.
- **A row with no machine, older than ten minutes:** it belongs to a crash. One later webhook takes it over.
- **A failed session or an expired computer:** the machine is deleted first, then its row. If the delete fails, the row stays, so the next event tries again.

</details>

<details>
<summary><h2>💚 Health checks</h2></summary>

- `GET /v1/health/live` says the app is running.
- `GET /v1/health/ready` says the app has enough memory to work.

Both also work on version 2, like `/v2/health/live`. They do not call other websites or databases.

</details>

<details>
<summary><h2>✅ Verification</h2></summary>

All tests are in `test/`.

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

Build one image and run it anywhere that runs containers, like Docker, Kubernetes, ECS, Cloud Run, Fly.io, Railway, or Render:

```bash
docker build --tag agentic:local .
docker run --rm --read-only --tmpfs /tmp --publish 3000:3000 agentic:local
```

The image uses pinned Bun and Node versions, has only production packages, and runs as the `node` user, not as root.

On start, the image applies new database migrations, then starts the app (see Database). Give it `DATABASE_URL` and nothing else is needed:

```bash
docker run --rm --read-only --tmpfs /tmp --publish 3000:3000 \
  --env DATABASE_URL=postgresql://user:password@db-host:5432/agentic \
  --env OPENAI_API_KEY=sk-... \
  agentic:local
```

**Coolify:** create a Postgres database in the same project, then add the app from this repository with the **Dockerfile** build pack and port `3000`. Paste the database's internal URL into `DATABASE_URL` and add your other settings. Every deploy runs the migrations by itself. Other hosts work the same way: build the Dockerfile and set `DATABASE_URL`.

> [!NOTE]
> The health check waits up to a minute after start, so a slow first migration does not mark the container unhealthy.

</details>

<details>
<summary><h2>🚀 CI/CD</h2></summary>

`.github/workflows/ci.yml` installs the exact lockfile, checks formatting and types, runs every test, checks packages for known problems, builds the app and the image, and scans the image. Every outside action is pinned to an exact commit.

When a package deep inside the tree pins a version with a known problem, `overrides` in `package.json` forces the fixed version. Today that is `zod` and `js-yaml`. Remove an override once the package that pins it ships a fix.

`.github/workflows/release.yml` runs when you push a version tag. It publishes images for Linux AMD64 and ARM64 to GitHub Container Registry, with a list of what is inside (SBOM) and a signed record of how it was built. Set up protection rules and reviewers on the `production` environment before your first release.

```bash
git tag v1.0.0
git push origin v1.0.0
```

</details>

<details>
<summary><h2>🛡️ Reliability and state</h2></summary>

> [!IMPORTANT]
> Everything that must survive a restart lives in Postgres: chats, waiting approvals, and self-hosted machines. The app itself keeps nothing in memory that matters, so you can start, stop, or roll back copies of it at any time.

How the database stays correct when two things happen at once:

| Action                         | Why it cannot happen twice                                                     |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Loading a saved approval       | One update marks it taken, inside a transaction. A second load finds it taken. |
| Creating a self-hosted machine | The session id is the row's key, so only one insert can win.                   |
| Removing a chat message        | One delete with `SKIP LOCKED`, so two removals take two different messages.    |

A sandbox computer lasts while it is open, until you save and resume it, or until a new one starts from its snapshot. See the `snapshotDir` warning in the Sandbox section.

The app shuts down cleanly. Its error handler also catches errors from middleware, gives every request a safe id, logs unexpected errors, and never shows internal details to callers.

</details>

## 📘 NestJS guidance applied

This project follows the NestJS guides for [exception filters](https://docs.nestjs.com/exception-filters), [security headers](https://docs.nestjs.com/techniques/security/cors), [CSRF protection](https://docs.nestjs.com/security/csrf), [validation](https://docs.nestjs.com/application/validation), [rate limiting](https://docs.nestjs.com/security/rate-limiting), and [shutdown hooks](https://docs.nestjs.com/fundamentals/lifecycle-events).

## ⭐ Acknowledgments

This Nestjs-OpenAI Agents SDK boilerplate was created by [Abolade Greatness](https://github.com/grtsnx).

Follow on [GitHub](https://github.com/grtsnx) and star [nestyagent](https://github.com/grtsnx/nestyagent).

- [X](https://x.com/grtsnx)
- [LinkedIn](https://www.linkedin.com/in/grtsnx)
- [grtsnx.com](https://grtsnx.com)
