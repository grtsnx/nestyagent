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

| Word         | Meaning                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| Agent        | A helper with one job.                                                                   |
| Instructions | The helper's job description. You write it once.                                         |
| Prompt       | The customer's message for one run.                                                      |
| Tool         | Something a helper can do, like look up the opening hours.                               |
| Schema       | A form. The helper fills it in instead of writing free text.                             |
| Session      | The chat history, so the helper remembers earlier messages.                              |
| Guardrail    | A safety check on a message, an answer, or a tool.                                       |
| Approval     | A pause where a person says yes or no before a tool runs.                                |
| Workspace    | A small computer the helper can use for files and commands.                              |
| Database     | Postgres. It stores chats, approval checkpoints, webhook events, and machine identities. |

## 📋 Requirements

- Bun 1.4.4
- Node.js 24 or later to run in production
- Postgres 14 or later for chats, approvals, and self-hosted machines
- Docker, or another OCI container runtime, to deploy

<details>
<summary><h2>🛠️ Local development</h2></summary>

```bash
cp .env.example .env
docker compose up -d --wait
bun install --frozen-lockfile
bun run db:migrate
bun run start:dev
```

`docker compose up -d --wait` starts this project's Postgres (`agentic-postgres`) from `compose.yaml`, at the same address as `DATABASE_URL` in `.env.example`. Its data lives in the `agentic_postgres-data` volume, so it survives a restart. `docker compose down` stops it and keeps the data. `docker compose down --volumes` deletes the data too.

`bun install` also builds the database client. `bun run db:migrate` creates the tables. The Prisma commands read `DATABASE_URL` from `.env` themselves. A value already set in your shell wins.

Swagger UI opens at `http://localhost:3000/api`. Scalar opens at `http://localhost:3000/docs`. The raw API documents are at `/api/v1-json` and `/api/v2-json`. The app prints every docs link when it starts.

</details>

<details>
<summary><h2>⚙️ Configuration</h2></summary>

The app checks these values before it starts. A bad port, a bad true/false value, or a bad CORS origin stops it.

| Variable                                                          | Default                  | What it does                                                                                                                          |
| ----------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                        | `development`            | Picks development, test, or production behavior.                                                                                      |
| `PORT`                                                            | `3000`                   | The HTTP port.                                                                                                                        |
| `PLATFORM_NAME`                                                   | `Agentic`                | The name shown on the API docs.                                                                                                       |
| `CORS_ORIGINS`                                                    | empty                    | Browser sites allowed to call the API, separated by commas. Empty allows none.                                                        |
| `SWAGGER_ENABLED`                                                 | on outside production    | Turns the API docs on. Set it yourself in production.                                                                                 |
| `OBSERVE_ENABLED`                                                 | `false`                  | Turns on NestJS Observe.                                                                                                              |
| `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET`, `OBSERVE_SERVICE_ID`     | empty                    | NestJS Observe login. Needed when `OBSERVE_ENABLED` is on.                                                                            |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | empty                    | Self-hosted Langfuse. Set all three to record traces there. Leave them empty to stay on the OpenAI dashboard.                         |
| `COMPOSIO_API_KEY`                                                | empty                    | Composio project key. Empty leaves Gmail, Slack, and other connected apps off. The app starts without it.                             |
| `ADMIN_API_KEY`                                                   | empty                    | Admin key for the admin routes: system prompts, monitoring, and ChatKit tokens. At least 32 characters. Empty keeps those routes off. |
| `CHATKIT_SECRET`                                                  | empty                    | Signs ChatKit user tokens and file links. At least 32 characters. Empty keeps the ChatKit routes off.                                 |
| `CHATKIT_TRANSCRIPTION_MODEL`                                     | `gpt-4o-mini-transcribe` | The model that turns ChatKit voice input into text.                                                                                   |
| `CHATKIT_MAX_UPLOAD_BYTES`                                        | `10485760` (10 MB)       | The largest file a ChatKit user can upload, up to 50 MB.                                                                              |
| `OPENAI_API_KEY`                                                  | required                 | Your OpenAI key. Every helper uses it. The app does not start without it.                                                             |
| `DATABASE_URL`                                                    | empty                    | Your Postgres address. The app starts without it. Chats, saved approvals, and the webhook need it.                                    |
| `OPENAI_HOSTED_MODEL`                                             | `gpt-6-astra`            | The model for a self-hosted session when you do not pick one.                                                                         |
| `ACCOUNT_PASSWORD`                                                | empty                    | One login password the helper can use inside its computer. Empty means no password.                                                   |
| `OPENAI_EXECUTOR_API_KEY`                                         | empty                    | The small key for a self-hosted computer. See Self-hosted.                                                                            |
| `OPENAI_WEBHOOK_SECRET`                                           | empty                    | Proves a webhook really came from OpenAI. Empty rejects every webhook.                                                                |
| `REMOTE_MACHINE_PROVIDER`                                         | `local`                  | Where the webhook starts a self-hosted computer: `local`, `aws`, `digitalocean`, `databricks`, or `oci`.                              |

The AWS, DigitalOcean, Databricks, OCI, and Cloudflare settings are in `.env.example`. The Self-hosted and Choose the computer sections say when you need them.

> [!CAUTION]
> Never put `*` in `CORS_ORIGINS`. Write each full site address, like `https://sunnybakery.example`.

</details>

<details>
<summary><h2>🗄️ Database</h2></summary>

The app uses Postgres through Prisma. The database keeps durable workflow records shared by every app replica:

| Table                     | What it keeps                                                                         | Key                                           |
| ------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| `chats`                   | One row per chat, with when it started and when it last moved.                        | The chat id you pick, like `chat-c-42`        |
| `chat_items`              | Every chat message, so a helper remembers the chat.                                   | A counter, so messages stay in exact order    |
| `paused_runs`             | Approval checkpoints, execution status, owner, and recovery notes.                    | A stable UUID assigned before saving          |
| `remote_machines`         | Which self-hosted machine belongs to which session.                                   | OpenAI's session id                           |
| `hosted_webhooks`         | Verified events, retries, worker leases, and terminal records.                        | OpenAI event id                               |
| `chat_history_operations` | Completed SDK history operations and their content digest.                            | Chat id + operation id                        |
| `execution_locks`         | Which worker is running a chat, a saved run, or a machine change.                     | The lock name, like `chat:chat-c-42`          |
| `expired_environments`    | Environments OpenAI said are gone, so they are never started again.                   | OpenAI's environment id                       |
| `system_prompts`          | Custom system prompts saved through the API. Without a row, the default file is used. | The helper name, like `mssuzie`               |
| `composio_sessions`       | Each user's Composio session, so a session id never comes from a request.             | The user id                                   |
| `agent_runs`              | One row per invocation: token deltas, time, result, and trace id. No message text.    | A UUID the database makes                     |
| `chatkit_threads`         | Each ChatKit chat, in ChatKit's own JSON shape, with its owner.                       | ChatKit's thread id, like `thr_…`             |
| `chatkit_items`           | Every message, widget, and step in a ChatKit chat.                                    | Thread id + item id, with a counter for order |
| `chatkit_attachments`     | Uploaded files: name, type, owner, and the bytes.                                     | ChatKit's attachment id, like `atc_…`         |
| `chatkit_feedback`        | Thumbs up or down on a ChatKit answer, for evals.                                     | A UUID the database makes                     |

How the tables are built:

- **Ids.** Approval ids are native UUID columns. New checkpoints receive a stable random UUID before saving so a retry can identify the same record. Worker claim tokens use random UUIDs. Ids from outside, like your chat ids and OpenAI's session ids, are kept as they are. Chat messages use a counter instead of a UUID, because the order of a chat must be exact.
- **Keys.** Each chat message points at its chat. Deleting a chat deletes its messages. One environment can only belong to one session.
- **Times.** Every table has `created_at`. Tables whose rows change also have `updated_at`. All times are stored with their time zone.
- **Indexes.** Only where a query needs one: a chat's messages by chat and order, and the machine for an environment. Webhook queue indexes cover due work and terminal-event lookups; history-operation ids deduplicate writes. Locks are found by owner, so a worker frees all of its locks in one step.

The app only connects the first time one of these is used. Without `DATABASE_URL`, everything else still works.

| Command               | When to run it                                                    |
| --------------------- | ----------------------------------------------------------------- |
| `bun run db:migrate`  | On your machine, after you change `prisma/schema.prisma`.         |
| `bun run db:deploy`   | Applies new tables. The container already runs it when it starts. |
| `bun run db:generate` | Rebuilds the database client. `bun install` already does this.    |

Drain old application workers before deploying a schema or execution-protocol change. When the container starts with `DATABASE_URL` set, it applies any new migrations first, then starts the app. If a migration fails, the app does not start, so it never runs against the wrong tables. Two copies starting at once are safe: Postgres lets one migrate while the other waits.

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

### See the run

Each customer message is a trace named `agent-turn`. A chat id groups those traces into one session. Traces always go to the OpenAI dashboard. Model messages and tool inputs and outputs stay off that trace until you turn payloads on. See [Check the answers (evals)](#check-the-answers-evals).

Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` to also send each trace to your self-hosted Langfuse. Langfuse gets the customer's message, the final answer, the chat id, the user id, the request id, the model, and token use. With payloads on, it also gets tool inputs and outputs. API keys in that text are masked. Turn Langfuse on only where storing customer messages is allowed.

A resumed approval is exported as another Langfuse trace segment, grouped by the same chat/session id. Runs inside one `traceWorkflow` publication share a trace while retaining their own inputs and outputs.

A trace appears in Langfuse only after a helper runs. This app ships no route that runs a helper, so the dashboard stays empty until your own code calls `runAgent`, `reply`, or `runSandbox`. If Langfuse is down, the app keeps working and those traces are dropped.

`traceWorkflow` puts several runs in one trace. `span` records a step the helper does not already record.

### Check the answers (evals)

Grade traces while you are still finding mistakes. Move to a dataset when you want the same checks again after a prompt, tool, or model change. Both happen in the OpenAI dashboard. This app's job is to send a trace a grader can actually read.

**1. Send a gradable trace**

Payloads stay off until you ask for them. A customer chat can stay redacted. A run you want to grade includes the model messages, the tool arguments, and the tool results.

```typescript
await this.openai.runAgent('Where is my order?', frontDesk, {
  session: chat,
  userId: 'c-42',
  workflowName: 'agent-turn',
  tracePayloads: true,
});
```

`workflowName` is optional. Leave it out and the dashboard workflow is still `agent-turn`. Pass `userId` when you want to filter by customer.

To grade every run in one environment, such as a staging shop, set this and restart:

```bash
TRACE_PAYLOADS=true
```

> [!WARNING]
> A gradable trace stores the customer message and the tool results in the OpenAI dashboard. Turn it on only where that storage is allowed. Langfuse still masks API keys in its copy.

**2. Grade it in Logs**

1. Open [Logs > Traces](https://platform.openai.com/logs?api=traces) and select the workflow `agent-turn`.
2. Open one trace. With payloads on you can see each model call, each tool call and its result, each handoff, and each guardrail.
3. Create a grader and run it on the traces you selected.
4. Use the scores to edit the prompt, the tools, the routing, or the guardrails.

| Question the grader asks                  | Sunny Bakery example                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| Did the helper pick the right tool?       | `cancel_order` runs when the customer asks to cancel, and stays quiet otherwise. |
| Did a handoff happen when it should have? | "Where is my order?" goes to Order helper.                                       |
| Did the run break a rule?                 | The answer leaves out the secret recipe, and a homework message is stopped.      |
| Did a prompt, tool, or model change help? | Grade the same kind of trace again after the change.                             |

Select **Grade all** when you want those checks across many traces. A run there can be narrowed by model, date, or tool call.

`traceWorkflow` puts several runs in one trace when one customer job is more than one helper call. `span` records a step the SDK does not already record.

**3. Repeat it on a dataset**

When you know what a good answer looks like, save those cases as a dataset and grade them again after each change.

1. Open the [evaluation datasets](https://platform.openai.com/evaluation) page and create one named `Sunny Bakery orders`.
2. Add rows. `message` is the customer text. `correct_price` or `expected_tool` is the ground truth. A CSV upload uses the same columns.
3. Generate outputs, then annotate a few. Mark one Good or Bad, and write a short note in `output_feedback`.
4. Add a grader. Run it, change the helper, and run it again. The new column shows what got better.

| Grader          | What it checks                               | Bakery example                              |
| --------------- | -------------------------------------------- | ------------------------------------------- |
| String check    | The answer matches the ground truth exactly. | The price is `$25`.                         |
| Text similarity | The answer is close to the ground truth.     | "Open every day from 7am to 6pm."           |
| Score model     | A model gives a number.                      | Friendliness from 1 to 5.                   |
| Label model     | A model picks one label.                     | `menu`, `order`, or `off-topic`.            |
| Python          | Your code scores the answer.                 | The reply does not contain `secret recipe`. |

The prompt optimizer rewrites the prompt from that dataset and those notes. Open it from the dataset when the same grader keeps failing.

Langfuse can score the same turns by hand, or with an LLM-as-a-judge, when you want a copy outside the OpenAI dashboard.

The older Evals API becomes read-only on October 31, 2026 and is removed on November 30, 2026. Use trace grading and datasets.

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

Only one active run may use a database chat at a time, across all app replicas. An overlapping request gets a conflict; queue it in your application or retry after the first run finishes. Streaming holds that lock until `stream.completed`, including history persistence. A saved pending approval blocks new messages until it is resolved.

Each new message budgets its model context to 200 items and 256,000 bytes by default, including the new input. Older history is trimmed only at whole-turn boundaries, so a tool result never loses the call it answers. The new input and the active turn remain whole even when they exceed these soft limits. On the next message, an oversized completed turn is left out. Approval resumes preserve the active turn from the saved SDK state. Change the limits with `createSession(chatId, { maxItems: 400, maxBytes: 512_000 })`. Limits only change what the model sees; every message stays stored. For very long chats, the SDK's `OpenAIResponsesCompactionSession` can summarize old turns.

Give each chat its own id, like the customer's chat id, and store it. Pass that id again tomorrow and the chat carries on. With no id, `createSession()` makes a new random one, which you can read with `await chat.getSessionId()`.

### Let OpenAI remember the chat

`previousResponseId` asks OpenAI to keep the earlier turns. Pass `nextResponseId` from the last answer, and send only the new message. Leave `session` out, because OpenAI already has those turns. A paused tool has no id yet. Finish that run, then use the id from the finished answer.

```typescript
const first = await this.openai.runAgent('Where is my order?', orderHelper);

const second = await this.openai.runAgent(
  'It was a birthday cake.',
  orderHelper,
  { previousResponseId: this.openai.nextResponseId(first) },
);
```

`reply` puts that same id on `turn.responseId`.

```typescript
const first = await this.openai.reply('Where is my order?', orderHelper);

const second = await this.openai.reply(
  'It was a birthday cake.',
  first.helper,
  { previousResponseId: first.responseId },
);
```

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

### Cheaper repeat questions (prompt caching)

OpenAI can cache repeated prompt prefixes. Database chats send the chat id as a prompt cache key, and a key supplied by the caller takes precedence. The key is applied to each OpenAI model request after the SDK merges the current specialist’s settings, including after handoffs. It is a routing hint, not an authorization boundary or a guarantee of a cache hit. Custom model adapters manage their own caching. Langfuse reports cached input separately from uncached input.

Pass your own key to share a cache across one customer's chats:

```typescript
await this.openai.runAgent('Any cakes today?', menuHelper, {
  session: chat,
  promptCacheKey: 'customer-c-42',
});
```

Keep the helper's instructions and tools the same between messages, because a cache only matches an unchanged start. A very long chat that drops old turns starts a new cache.

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

`reply` runs one message. Pass the same `session` so the chat is remembered. `fallback` is optional. `turn.helper` is who should take the next message. `turn.output` is the answer. When OpenAI keeps the earlier turns, `turn.responseId` is the id to pass next. See [Let OpenAI remember the chat](#let-openai-remember-the-chat).

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
<summary><h2>🔗 Connected apps</h2></summary>

`ComposioService` lets a helper use the account owner's Gmail, Slack, and the other apps Composio hosts. Leave `COMPOSIO_API_KEY` empty and connected apps stay off. The app still starts.

Put the project key in `.env` and restart:

```bash
COMPOSIO_API_KEY=your-project-key
```

Inject `ComposioService` the same way you inject `OpenaiService`.

### Give a helper the owner's apps

Pass the owner's user id. Composio's tools come back ready for `createAgent`.

```typescript
const connected = await this.composio.tools(user.id); // from login, never from the request body

const helper = this.openai.createAgent(
  'Front desk',
  'Help the Sunny Bakery owner with mail and messages. When an app needs permission, share the Connect Link and wait.',
  { tools: [bakeryHours, ...connected.tools] },
);
```

- **The user id comes from your login.** It must be stable, and `default` is rejected. Never take it from what a caller sends, or one person could reach another person's Gmail.
- **The session stays on the server.** The first call opens a Composio session and saves its id in Postgres. Later calls reuse it, and a new one is made if Composio drops it. Making a session never touches the owner's apps, so a failed attempt is simply tried again on the next call; a session that could not be saved is deleted. Calls in one server share one creation. If another server is creating the same owner's session at that moment, the call gets 409 and can retry a moment later. Without `DATABASE_URL`, each call opens a new session; connections belong to the owner, so nothing is lost.
- **First time.** When Gmail or Slack is not connected yet, the helper gets a Connect Link. Show it to the owner. The next message can use the app.

### Every action waits for a yes

Looking things up runs on its own: finding tools, reading tool details, and making a Connect Link. Everything else pauses first, because it acts in the owner's real accounts: sending an email, posting to Slack, changing a calendar, running code. Any tool Composio adds later also waits.

```typescript
const chat = this.openai.createSession('chat-owner-c-42');
const turn = await this.openai.reply(
  'Reply to the cake order and say it is ready.',
  helper,
  { session: chat },
);

if (turn.waiting) {
  // Show turn.result.interruptions to the owner: what will be sent, and where.
  const done = await this.openai.finish(turn, 'approve'); // or 'reject'
}
```

A person can decide later, too. The paused run is saved, the same way as [Decide later](#decide-later).

Tool requests receive the run's cancellation signal, the application's shutdown signal, and a two-minute timeout, and are never retried automatically. A failed lookup goes back to the model, which can try again or explain. A failed or uncertain action stops the run with `ComposioActionError`, carrying the session, tool, call, and available log ids, because nobody knows yet whether the email was sent. A saved approval enters recovery when resumed execution fails. Inspect the remote action before calling `recoverRun`; cancellation cannot undo an action the remote service already accepted.

</details>

<details>
<summary><h2>📝 System prompts</h2></summary>

A helper's system prompt can be changed from Swagger or Scalar without a deploy. The built-in text lives in `src/config/system-prompts`, one Markdown file per helper, and MsSuzie's is `mssuzie.md`. A saved custom version replaces it. Delete the custom version and the built-in text comes back.

Set `ADMIN_API_KEY` to turn the routes on. Every request sends it in the `x-admin-key` header. In Swagger, click **Authorize** and paste the key once. Without the key set, the routes answer 403 and nothing can be changed.

| Route                             | What it does                                                 |
| --------------------------------- | ------------------------------------------------------------ |
| `GET /v1/system-prompts`          | Lists each helper and whether it uses custom or default text |
| `GET /v1/system-prompts/:name`    | Shows the text in use now                                    |
| `POST /v1/system-prompts/:name`   | Saves a custom version                                       |
| `PUT /v1/system-prompts/:name`    | Replaces the custom version                                  |
| `DELETE /v1/system-prompts/:name` | Deletes the custom version, so the default is used again     |

**Two people editing at once.** Every reply carries a `version`. Send that number back with `PUT` (in the body) or `DELETE` (as `?version=2`). If someone saved since you read it, you get 409 and their change is kept. Reload, then try again. Versions come from a database sequence shared by all prompts and survive deletion. Treat them as opaque revision numbers: they need not start at 1 or increase by exactly 1. Updating returns the content and revision written by that request.

**Use it in a helper.** Import `SystemPromptsModule` (from `src/modules/system-prompts`) into your module, inject `SystemPromptsService`, and pass `forAgent` instead of fixed text. The helper reads the latest text before each model call, so a change applies to the next message.

```typescript
const frontDesk = this.openai.createAgent(
  'MsSuzie',
  this.systemPrompts.forAgent('mssuzie'),
);
```

Each server keeps the text in memory for 5 seconds, so another server sees an edit within that time while the database is available. Local writes invalidate the cache, and an older in-flight read cannot restore the invalidated text. If the database is down, the helper keeps the last text it saw, then the built-in file. Saving needs `DATABASE_URL`.

To add a helper, add `src/config/system-prompts/<name>.md` and list it in `src/config/system-prompts/index.ts`. Only names with a built-in file can be used with `forAgent`, so a helper is never left without a system prompt.

</details>

<details>
<summary><h2>💬 ChatKit</h2></summary>

[ChatKit](https://developers.openai.com/api/docs/guides/custom-chatkit) is OpenAI's ready-made chat window for websites. This app is its server. A customer on the Sunny Bakery site types "Do you have gluten-free bread?", and MsSuzie answers in the window, with streaming text, cards, buttons, file uploads, and voice input.

```
Bakery website (ChatKit window)  ──POST /v1/chatkit──▶  this app  ──▶  MsSuzie helper  ──▶  OpenAI
        ▲                                                  │
        └──────────── streamed answer (SSE) ───────────────┘   chats saved in Postgres
```

The code is in three places:

| Folder                | What it is                                                                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/chatkit`     | `chatkit.module.ts` registers the shared providers and is imported/exported by `LibModule`. `chatkit.service.ts` contains the protocol service, types, validation, durable operations, widgets, and SDK bridge. |
| `src/config/chatkit`  | Sunny Bakery's setup: user tokens and file links (`chatkit.auth.ts`) and the Postgres store (`chatkit.store.ts`).                                                                                               |
| `src/modules/chatkit` | The routes and `MsSuzieChatKitService`, which extends the library service and answers every message; its module imports the shared ChatKit library module.                                                      |

### Turn it on

1. Set `CHATKIT_SECRET` to a random value of at least 32 characters, like `openssl rand -base64 48`. Without it, every ChatKit route answers 403.
2. Set `ADMIN_API_KEY`, so your own backend can ask for user tokens.
3. Put the bakery website in `CORS_ORIGINS`, like `https://sunnybakery.example`. Without it, the browser blocks the requests.
4. Add the website's domain to your OpenAI [domain allowlist](https://platform.openai.com/settings/organization/security/domain-allowlist). OpenAI gives you a `domainKey` for it.
5. Run `bun run db:deploy` and `bun run db:generate` to apply the ChatKit tables, approval bindings, and conversation usage migration.

| Setting                       | Default                  | What it does                                               |
| ----------------------------- | ------------------------ | ---------------------------------------------------------- |
| `CHATKIT_SECRET`              | empty                    | Signs user tokens and file links. Empty keeps ChatKit off. |
| `CHATKIT_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` | The model that turns voice input into text.                |
| `CHATKIT_MAX_UPLOAD_BYTES`    | `10485760` (10 MB)       | The largest file a user can upload, up to 50 MB.           |

### Routes

| Route                                                         | Who calls it                     | What it does                                                            |
| ------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| `POST /v1/chatkit/tokens`                                     | Your backend, with the admin key | Gives one signed-in user a short-lived ChatKit token.                   |
| `POST /v1/chatkit`                                            | The ChatKit window               | Every chat request: messages, history, actions, feedback, and voice.    |
| `POST /v1/chatkit/attachments`                                | The ChatKit window               | Direct upload of one file.                                              |
| `POST /v1/chatkit/attachments/:id/upload`                     | The ChatKit window               | Second step of a two-phase upload, through a signed link.               |
| `GET /v1/chatkit/attachments/:id/content`                     | The browser                      | Shows an image, or downloads a file, through a signed link.             |
| `POST /v1/chatkit/threads/:threadId/recover`                  | An admin, with the admin key     | Unpauses a chat after an interrupted browser tool or retry was checked. |
| `POST /v1/chatkit/threads/:threadId/approvals/:runId/recover` | An admin, with the admin key     | Shows an interrupted approval's card again, after it was checked.       |

### Give each user a token

The browser never sees the admin key. Your own backend checks who is logged in, then asks this app for a token for that person:

```bash
curl -X POST https://api.sunnybakery.example/v1/chatkit/tokens \
  -H "x-admin-key: $ADMIN_API_KEY" -H "content-type: application/json" \
  -d '{"userId": "customer-42", "ttlSeconds": 3600}'
```

```json
{
  "statusCode": 201,
  "statusType": "CREATED",
  "message": "Success",
  "data": { "token": "eyJhbGciOi…", "expiresAt": "2026-10-27T10:00:00.000Z" }
}
```

- `userId` comes from your login, never from the browser. Every chat and file belongs to it.
- `ttlSeconds` is from 60 to 86400 (one day). The default is one hour. Ask for a new token before `expiresAt`.
- The token is a standard HS256 JWT with `sub` (the user), `aud` `chatkit`, `iat`, and `exp`.

### Put the window on the website

React, with `@openai/chatkit-react`:

```tsx
import { ChatKit, useChatKit } from '@openai/chatkit-react';

const API = 'https://api.sunnybakery.example';

export function BakeryChat() {
  const { control } = useChatKit({
    api: {
      url: `${API}/v1/chatkit`,
      domainKey: 'domain_pk_…', // from the OpenAI domain allowlist
      // Adds the user's token to every request, uploads included.
      fetch: async (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            Authorization: `Bearer ${await getToken()}`,
          },
        }),
      uploadStrategy: {
        type: 'direct',
        uploadUrl: `${API}/v1/chatkit/attachments`,
      },
    },
    composer: { attachments: { enabled: true, maxCount: 3 } },
  });
  return <ChatKit control={control} className="h-[600px] w-[360px]" />;
}
```

`getToken()` is your own function. It calls your backend, which calls `POST /v1/chatkit/tokens`, and keeps the token until shortly before `expiresAt`.

Without React, load `https://cdn.platform.openai.com/deployments/chatkit/chatkit.js`, add an `<openai-chatkit>` element, and call `element.setOptions({ api: { … } })` with the same options.

### Make it look like the bakery

All of these go in the same options object, next to `api`. They change only the window, so the server needs nothing for them.

```typescript
useChatKit({
  api: { … },
  theme: {
    colorScheme: 'light', // or 'dark'
    color: {
      accent: { primary: '#D97706', level: 2 },
      grayscale: { hue: 30, tint: 2 },
      surface: { background: '#FFFBF5', foreground: '#1F2937' },
    },
    radius: 'round', // 'pill', 'round', 'soft', or 'sharp'
    density: 'normal', // 'compact', 'normal', or 'spacious'
    typography: { fontFamily: "'Inter', sans-serif" },
  },
  startScreen: {
    greeting: 'Welcome to Sunny Bakery!',
    prompts: [
      { name: 'Opening hours', prompt: 'When are you open today?', icon: 'calendar' },
      { name: 'Order a cake', prompt: 'I want to order a birthday cake.', icon: 'write' },
    ],
  },
  composer: {
    placeholder: 'Ask about cakes, bread, or your order…',
    attachments: { enabled: true, maxSize: 10 * 1024 * 1024, maxCount: 3, accept: { 'image/*': ['.png', '.jpg'] } },
    tools: [{ id: 'order', label: 'Track order', icon: 'search', pinned: true }],
    dictation: { enabled: true },
  },
  header: {
    customButtonLeft: { icon: 'settings-cog', onClick: () => openSettings() },
    customButtonRight: { icon: 'home', onClick: () => goHome() },
  },
  history: { enabled: true },
  threadItemActions: { feedback: true, retry: true },
  disclaimer: { text: 'MsSuzie can make mistakes. Check your order details.' },
  locale: 'en-GB',
  initialThread: savedThreadId, // or null for a new chat
});
```

| Option              | What it changes                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `theme`             | Light or dark, accent and gray colors, surfaces, corner radius, spacing, and font.        |
| `startScreen`       | The greeting and the starter prompts on a new chat.                                       |
| `composer`          | Placeholder, attachments, tool menu, model picker, and voice input.                       |
| `header`, `history` | The top bar, its custom buttons, and the list of old chats. Set `enabled: false` to hide. |
| `threadItemActions` | Thumbs up and down (`feedback`) and the retry button (`retry`) under each answer.         |
| `disclaimer`        | A short line under the composer.                                                          |
| `entities`          | @-mentions: `onTagSearch`, `onClick`, and `onRequestPreview`. See below.                  |
| `locale`            | The window's language. Without it, ChatKit uses the browser's.                            |
| `initialThread`     | The chat to open first. Save the id from `chatkit.thread.change` to reopen it later.      |

The window also sends events you can listen to: `chatkit.ready`, `chatkit.error`, `chatkit.response.start`, `chatkit.response.end`, `chatkit.thread.change`, `chatkit.thread.load.start`, `chatkit.thread.load.end`, `chatkit.effect`, and `chatkit.log`. On the web component, use `element.addEventListener('chatkit.thread.change', …)`. The React hook takes the same events as callbacks.

### What the server does with each message

`MsSuzieChatKitService` in `src/modules/chatkit/chatkit.service.ts` answers every message:

1. A new chat is named after its first message, up to 60 characters.
2. The last 50 items of the chat go to MsSuzie as history. Images go as pictures, and other files go with their name.
3. MsSuzie uses her editable system prompt (see System prompts) and runs through `OpenaiService`, so `agent_runs`, traces, and prompt caching all work. Each turn is recorded with workflow `chatkit-turn`, the user's id, the thread id, and conversation type `chatkit`. Admin chat summaries include these conversations.
4. The answer streams back word by word. When it ends, every item is saved in `chatkit_items`.

Only one answer runs per chat at a time, across all servers. The first turn acquires its lock before publishing the new thread id. Every storage mutation checks lease ownership inside its database transaction, so an expired worker cannot overwrite its replacement. SSE writes wait for the browser to drain its buffer.

| What the user does                    | What happens on the server                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Presses stop                          | The run stops. Text that already arrived is kept, and MsSuzie is told the user stopped her.                             |
| Presses retry (`retry: true`)         | The suffix and a retry marker commit together, then MsSuzie answers again; failed deletion preserves the whole history. |
| Thumbs up or down (`feedback: true`)  | A row goes into `chatkit_feedback`, for evals. Only on the user's own chat.                                             |
| Speaks (`dictation`)                  | The audio is turned into text with `CHATKIT_TRANSCRIPTION_MODEL`, and the text lands in the composer.                   |
| Renames or deletes a chat             | The chat is updated or deleted, with its items and files.                                                               |
| Picks a tool or model in the composer | It arrives as `input.inference_options` on the message. MsSuzie ignores it until you read it in `respond`.              |

> [!NOTE]
> Voice input arrives as JSON, and the app keeps Nest's normal JSON size limit (100 KB). Base64 encoding counts toward that limit, so the usable audio duration depends on its codec and bitrate. A larger request gets 413.

### Files and pictures

Two ways to upload. Pick one with `uploadStrategy`:

| Strategy                                                    | How it works                                                                                                                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ type: 'direct', uploadUrl: '…/v1/chatkit/attachments' }` | The window sends the file in one request, with the user's token.                                                                                                                                                |
| `{ type: 'two_phase' }`                                     | The window first asks for an upload link, then sends the file there. The upload permission expires after 15 minutes, works once, and refuses a file larger than the window announced; it needs no bearer token. |

- The file and its bytes are saved atomically in `chatkit_attachments`. An attachment binds to one thread and cannot move to another; upload it again to reuse it elsewhere. Deleting the chat deletes its files.
- Images get a `preview_url`. It is a signed link that only works for that file and its owner, so the image shows in the chat without a token.
- Only PNG, JPEG, GIF, and WebP open in the page. Every other file downloads, so an uploaded web page can never run on this site.
- Authentication or upload permission validation runs before multipart buffering. `CHATKIT_MAX_UPLOAD_BYTES` is the actual parser limit; oversized files return 413. Empty files and missing types return 400. Read links cannot upload, and completed uploads cannot be overwritten.

### Cards and buttons (widgets)

A tool can show a widget instead of plain text. The tool gets the chat through `runContext.context`, which is an `AgentContext`:

```typescript
import type {
  AgentContext,
  WidgetRoot,
} from '@/lib/chatkit/chatkit.service.js';
import { actionConfig } from '@/lib/chatkit/chatkit.service.js';

const showCakes = tool({
  name: 'show_cakes',
  description: 'Show the cakes that can be ordered today.',
  parameters: z.object({}),
  execute: async (_input, runContext) => {
    const chat = runContext?.context as AgentContext<ChatKitContext>;
    chat.streamProgress('Checking the oven…', 'search');
    const cakes: WidgetRoot = {
      type: 'ListView',
      children: todaysCakes.map((cake) => ({
        type: 'ListViewItem',
        children: [{ type: 'Text', value: `${cake.name} · £${cake.price}` }],
        onClickAction: actionConfig('cake.order', { cakeId: cake.id }),
      })),
    };
    await chat.streamWidget(cakes, 'Cakes for today');
    return 'Showed the cakes.';
  },
});
```

| Helper on `AgentContext`                                                | What it does                                                            |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `streamWidget(widget, copyText?)`                                       | Shows a widget. Pass an async iterable to update it as it changes.      |
| `streamProgress(text, icon?)`                                           | A short status line while a slow tool works. The next item replaces it. |
| `startWorkflow`, `addWorkflowTask`, `updateWorkflowTask`, `endWorkflow` | A list of steps the user can open, like "Checked stock, booked oven".   |

Widgets have two outer shapes, `Card` and `ListView`. Inside them you can use `Box`, `Row`, `Col`, `Text`, `Title`, `Caption`, `Markdown`, `Badge`, `Button`, `Icon`, `Image`, `Divider`, `Spacer`, `Select`, `DatePicker`, `Form`, `ListViewItem`, and `Transition`. `Text` and `Markdown` can stream. Design one in the [Widget Builder](https://widgets.chatkit.studio) and paste its JSON. The types come from `@openai/chatkit`, so a wrong field fails the type check.

MsSuzie's tools go in `agent()` in `src/modules/chatkit/chatkit.service.ts`: `this.openai.createAgent('MsSuzie', …, { tools: [showCakes] })`.

### Actions

A button, a form, or a list item can send an action. `actionConfig(type, payload, options)` makes one.

| Option            | Default    | What it does                                                                                  |
| ----------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `handler`         | `'server'` | `'server'` sends it to `action()` here. `'client'` sends it to the page's `widgets.onAction`. |
| `loadingBehavior` | `'auto'`   | What shows a spinner: `'self'`, `'container'`, `'none'`, or `'auto'` to let ChatKit pick.     |
| `streaming`       | `true`     | `false` sends it to `syncAction()`, which updates the widget without a new answer.            |

**On the server.** Add a branch to `action()` in `src/modules/chatkit/chatkit.service.ts`. The browser sends the payload, so check it with zod first, like the approval actions do. Never trust a price or an id just because it is in the payload.

```typescript
const cakeOrder = z.object({
  type: z.literal('cake.order'),
  payload: z.object({ cakeId: z.string() }),
});

// In action(), before the approval branch:
const order = cakeOrder.safeParse(action);
if (order.success) {
  await this.orders.add(context.userId, order.data.payload.cakeId);
  // Tell MsSuzie what happened, then let her answer.
  await this.store.addThreadItem(
    thread.id,
    {
      type: 'sdk_hidden_context',
      id: this.store.generateItemId('sdk_hidden_context', thread, context),
      thread_id: thread.id,
      created_at: new Date().toISOString(),
      content: 'The customer ordered a cake.',
    },
    context,
  );
  yield * this.respond(thread, undefined, context);
  return;
}
```

**Forms.** Every field inside a `Form`, or a `Card` with `asForm: true`, is added to the action's payload under its `name`. A name with dots makes nested keys. A field whose name is already in the payload is ignored.

**On the page.** Use `handler: 'client'` for things only the page can do, like opening the cart. Send it on to the server when needed:

```typescript
widgets: {
  async onAction(action, widgetItem) {
    if (action.type === 'cart.open') openCart();
    await chatkit.sendCustomAction(action, widgetItem.id); // optional
  },
},
```

### Approvals

When MsSuzie calls a tool that needs a yes, like `cancelOrder`, the run pauses and saves itself (see Decide later). The chat shows a card with the tool and its inputs, and **Approve** and **Decline** buttons.

- Only the user who owns the run can answer it. Anyone else gets "This request was already answered."
- A checkpoint and its approval card commit together. Each action binds to the user, original thread, card, and checkpoint version. A stale card cannot approve a later pause.
- Editing MsSuzie's system prompt does not touch waiting cards: they can still be answered, and the next step uses the new prompt.
- Runs also save `AGENT_VERSION` from `src/modules/chatkit/chatkit.service.ts`. Change it when MsSuzie's tools change in a way an old run cannot handle. A card saved before that change closes as "This request expired after an update. Please ask again." when clicked, and nothing runs.
- The card changes to "Approved." or "Declined." only after the saved run is claimed.
- **A new message means no.** If the customer types instead of clicking, the waiting request is cancelled without running, its card shows "Declined.", and MsSuzie answers the new message.
- **An interrupted action pauses the chat.** If a server stops while an approved action runs, nobody knows whether it happened. The chat shows "This chat is paused while the team checks an earlier action. Please try again later." until an admin checks it (see below).
- Deleting the thread deletes its live approval checkpoints. Another thread cannot resume them. A second click cannot execute a completed checkpoint again.

### Tools the browser runs (client tools)

Some tools only the page can do, like reading the basket. Give MsSuzie a `clientTool` and stop the run there, so the page can answer:

```typescript
import {
  clientTool,
  clientToolStopBehavior,
} from '@/lib/chatkit/chatkit.service.js';

const readBasket = clientTool({
  name: 'read_basket',
  description: 'Read what is in the customer’s basket.',
  parameters: { type: 'object', properties: {} },
});

this.openai.createAgent('MsSuzie', this.systemPrompts.forAgent('mssuzie'), {
  tools: [readBasket],
  toolUseBehavior: clientToolStopBehavior(['read_basket']),
  modelSettings: { parallelToolCalls: false },
});
```

On the page, answer it with `onClientTool`. What you return goes back to MsSuzie, and she answers again:

```typescript
onClientTool: async ({ name }) => (name === 'read_basket' ? { items: basket.items } : {}),
```

The wire protocol carries a result without a tool-call id. Keep browser tools serial: the bridge rejects multiple browser calls from one model turn before dispatching any of them. A browser call mixed with server tools keeps its own SDK call identity.

Accepted results and continuation markers commit together. An explicitly retryable failure can continue from the saved result; an uncertain failure or a worker restart leaves the operation blocked for reconciliation. Duplicate completed results do not rerun the completed continuation. Retry deletion follows the same durable operation lifecycle. Only an explicit `CustomStreamError(message, true)` certifies that the application can safely retry before committing output; generic stream failures require reconciliation.

For custom clients, set `metadata.client_tool_call_id` on every tool-result request to the pending item's `call_id`. The first call accepts the stock request shape; later new calls require this identity so a delayed earlier result cannot be assigned to the wrong tool. An identical retry of the currently completed result does nothing. Custom clients that use multiple browser tools must supply this field through their request adapter. Set `metadata.operation_id` to a new id for each deliberate retry, preserving it on network retries. Without that id, repeating a successful retry for the same message does nothing. These fields resolve ambiguities in the stock request shape.

**Unpause a chat.** An admin first checks the real system, for example whether order 42 was really cancelled, then calls one of these with the admin key. Both take the same thread lock as chat requests and check the owner. Neither undoes an action, so check first.

When a browser tool or a retry was interrupted, run it again (`retry`) or close it (`cancel`):

```bash
curl -X POST https://api.sunnybakery.example/v1/chatkit/threads/thr_…/recover \
  -H "x-admin-key: $ADMIN_API_KEY" -H "content-type: application/json" \
  -d '{"userId": "customer-42", "decision": "cancel", "note": "Checked: the basket was not changed."}'
```

When an approved action was interrupted, show its card again so the customer can answer it. Take `version` from `GET /v1/admin/approvals`:

```bash
curl -X POST https://api.sunnybakery.example/v1/chatkit/threads/thr_…/approvals/<runId>/recover \
  -H "x-admin-key: $ADMIN_API_KEY" -H "content-type: application/json" \
  -d '{"userId": "customer-42", "version": 1, "note": "Checked: order 42 was not cancelled."}'
```

The new card is saved with a new version, and the customer sees it when the chat reloads. Older cards stay invalid. A chat with nothing to recover answers 400, and another user's chat or run answers 404. The migration upgrades the latest legacy waiting card so existing threads can still answer their approvals. Historical usage rows without thread identity cannot be linked retrospectively.

### @-mentions (entities)

With `entities.onTagSearch` on the page, a user can type `@` and pick something, like a cake or an order. MsSuzie sees the tag's text and its `data`. To show more, such as the order's status, extend `ThreadItemConverter.tagToMessageContent` in `src/modules/chatkit/chatkit.service.ts`.

### Keep it safe

- **Validated requests.** Every request variant validates its required ids and nested fields before routing, with bounded page sizes, attachment counts, and payload depth. Application-specific action payloads still need their own schemas.
- **One user, one set of chats.** Every read and write is checked against the token's user. Another user's chat id answers 404, never its content. A chat id that already belongs to someone else cannot be taken over.
- **Secrets stay on the server.** Thread `metadata` is saved, but never sent to the browser. Hidden items, like the "user stopped" note, are never sent either.
- **Short tokens.** At most one day. The admin key never reaches the browser.
- **Signed file links.** A link works only for one file and its owner. A wrong signature answers 404, and deleting the file stops the link.
- **Untrusted actions.** Check every action payload with zod. Errors inside a stream reach the browser as a short message, never as a stack trace.
- **Language.** The window sends `Accept-Language`. The server keeps the first valid tag in `context.locale`, so `respond` can use it, for example to answer in French.

### Tables

| Table                 | What it keeps                                               |
| --------------------- | ----------------------------------------------------------- |
| `chatkit_threads`     | Each chat in ChatKit's own JSON shape, with its owner.      |
| `chatkit_items`       | Messages, widgets, steps, and hidden notes, in exact order. |
| `chatkit_attachments` | Uploaded files, their owner, and their bytes.               |
| `chatkit_feedback`    | Thumbs up and down, with the items they are about.          |

Items are stored as ChatKit JSON; structural database changes still require migrations. Deleting a chat deletes its items, files, and bound approval checkpoints. Responses streaming and Chat Completions final messages share the same persisted assistant-message format. Hidden events stay server-side, and opaque JSON payloads retain explicit `null` values.

</details>

<details>
<summary><h2>📊 Monitoring</h2></summary>

The admin routes show what needs a person, how the helpers are doing, and what they cost. They use the same `ADMIN_API_KEY` and `x-admin-key` header as the system prompt routes, and they only read. They need `DATABASE_URL`.

| Route                     | What it shows                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/admin/overview`  | What needs a person now, and the last 24 hours: chats, messages, runs, failures, tokens, cache hits, speed                               |
| `GET /v1/admin/usage`     | The same numbers per day and per model. `?days=14`, up to 90                                                                             |
| `GET /v1/admin/runs`      | Recent helper runs, newest first. Filter with `?status=failed`, `?chatId=`, or `?agent=`                                                 |
| `GET /v1/admin/approvals` | Runs waiting for a person, oldest first, with how long each has waited. `?status=recovery_required` lists runs a crash left for checking |
| `GET /v1/admin/chats`     | The most recently active chats, with message and run counts                                                                              |
| `GET /v1/admin/webhooks`  | OpenAI webhook events, their attempts, and their last error code                                                                         |
| `GET /v1/admin/machines`  | Self-hosted machines, their provider, and their state                                                                                    |

Every list takes `?limit=`, from 1 to 200.

**Where the numbers come from.** Each helper invocation writes one row to `agent_runs` when it ends: the helper, the model, the tokens, cached tokens, how long it took, whether it finished, paused, or failed, and its trace id. Open that trace id in Langfuse or the OpenAI dashboard to see the whole run. If the row cannot be written, the chat still works and the server logs a warning. Approval resumes record only usage added by that invocation, and failed runs retain usage reported by the SDK. The actual chat id is stored separately from trace grouping. A run that spans several models is labelled `mixed`; unresolved custom models are `unknown`. Use request-level traces for per-model costs.

`cacheHitRate` is cached input tokens divided by all input tokens. Recovery counts and `?status=recovery_required` include abandoned `running` checkpoints with no live run lease, as well as explicitly flagged checkpoints. Chat summaries aggregate only the requested page of chats.

**What is never shown.** No message text, no saved run state, no machine claim tokens, and no webhook lease tokens. Run errors are fixed categories, such as `input_guardrail` or `run_failed`, rather than raw exception messages. A Guardian's words about a Learner stay out of the admin routes.

</details>

<details>
<summary><h2>🔌 MCP</h2></summary>

MCP lets a helper use tools that live in another project, like a recipe store or a supplier's catalog. There are three kinds:

| Kind   | Make it with | Who connects                                 | Use it for                               |
| ------ | ------------ | -------------------------------------------- | ---------------------------------------- |
| Hosted | `hostedMcp`  | OpenAI calls the server for you              | A public server on the internet          |
| HTTP   | `httpMcp`    | This app connects over HTTP                  | A private server only this app can reach |
| Local  | `stdioMcp`   | This app starts a command on its own machine | A tool you run next to the app           |

### A public server

A hosted server is just a tool. Pass it to the helper like any other tool.

```typescript
const supplier = this.openai.hostedMcp({
  serverLabel: 'supplier',
  serverUrl: 'https://flour-supplier.example/mcp',
});

const stockHelper = this.openai.createAgent(
  'Stock helper',
  'You check flour and sugar stock for Sunny Bakery.',
  { tools: [supplier] },
);
```

### A private server

`useMcp` connects the servers, runs your code with the ones that connected, then closes them, even when the run fails. Pass those servers to the helper as `mcpServers`.

```typescript
const recipes = this.openai.httpMcp({
  name: 'recipes',
  url: 'https://recipes.internal.example/mcp',
});
const notes = this.openai.stdioMcp({
  name: 'notes',
  fullCommand: 'npx -y @modelcontextprotocol/server-filesystem ./notes',
});

await this.openai.useMcp([recipes, notes], async (servers) => {
  const recipeHelper = this.openai.createAgent(
    'Recipe helper',
    'You answer questions about Sunny Bakery recipes.',
    { mcpServers: servers },
  );
  await this.openai.runAgent(
    'How much butter goes in a croissant?',
    recipeHelper,
  );
});
```

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

A person may not answer right away. Database-backed runs automatically save an approval checkpoint before returning a paused result. `saveRun` returns that checkpoint's id; for a run without a database chat, call it explicitly. Chat identity, history limits, turn limits, WebSocket selection, and a string blocked-output message are stored with the state.

```typescript
const ownerId = authenticatedCustomer.id; // take this from your server's authentication
const agentVersion = 'orders-v1';
const result = await this.openai.runAgent('Cancel order 123.', orderHelper, {
  session: chat,
  ownerId,
  agentVersion,
  maxTurns: 5,
});
const runId = await this.openai.saveRun(result);

// Later, possibly on another app replica:
const state = await this.openai.loadRun(orderHelper, runId, {
  ownerId,
  agentVersion,
});
this.openai.approve({ state });
const finished = await this.openai.resumeAgent(orderHelper, state);
```

Concurrent `saveRun` calls for the same live state object share one write and checkpoint id. Retrying after a lost database acknowledgement uses that same id. Independent objects or application requests still need caller-owned idempotency; this does not deduplicate arbitrary requests across processes.

Loading a checkpoint does not consume it. Resuming acquires its database execution lock and claims its version; a second or stale resume is rejected. The original database session is restored automatically. Supply the same agent definition, owner, and configuration version. Bind chat ids to authenticated users in your application; these helpers do not provide an authentication endpoint.

`reply()` and `finish()` preserve the session, cancellation signal, and execution options during an in-process approval. Signals, formatter functions, and live sandbox objects cannot be restored from database JSON; reattach runtime-only configuration when resuming after a restart.

A crash or failed resumed execution leaves `running` or `recovery_required`. Inspect **all external actions since the saved checkpoint** before retrying. Confirm that they did not happen, were compensated, or use stable idempotency keys. Then:

```typescript
const state = await this.openai.recoverRun(orderHelper, runId, {
  ownerId,
  agentVersion,
  note: 'Checked the order system; retrying uses the original idempotency key.',
});
const finished = await this.openai.resumeAgent(orderHelper, state);
```

`recoverRun` requires a reconciliation note and refuses to reclaim a run while another worker holds its execution lock. It does not prove that an external action is safe to repeat. Completed checkpoints remain available for audit but cannot be executed again.

### Nobody answers

While a question waits, that chat takes no new messages. If the customer never answers, `cancelRun` settles the waiting checkpoint and its chat history in one database transaction. It removes unexecuted approval placeholders and adds a cancellation message without calling a model or tool. The checkpoint becomes `completed` with recovery note `cancelled`, and the method returns `{ id, status: 'cancelled' }`. Repeating cancellation returns the same receipt; a stale resume is rejected. Interrupted actions must be reconciled before cancellation.

```typescript
const receipt = await this.openai.cancelRun(orderHelper, runId, {
  ownerId,
  agentVersion,
  message: 'The customer did not confirm in time.', // optional chat message
});
```

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
<summary><h2>💻 Sandbox</h2></summary>

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
> A saved computer does not keep the password. It comes from `.env` or the supplied `password` option again when you open or resume. Resume applies it to the live workspace through the SDK before returning; if that fails, the workspace is closed. Adding a password preserves existing mount credential acknowledgements.

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
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends rclone fuse3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
```

Build it with `docker build --tag bakery-sandbox .`, then pass `image: 'bakery-sandbox'`.

Storage is read-only unless you pass `readOnly: false`. Keep keys on the mount or in the rclone config. Never put them in a prompt.

### Private git projects

Use `prepareManifest` for authenticated repositories. It clones with credentials scoped to that child process and prepares files with their Git executable modes. Pass the complete prepared object to `openSandbox` so validated relative symlinks are installed before the workspace is returned. The synchronous `createManifest` rejects token-bearing repo shortcuts rather than putting credentials in shared process state.

```typescript
import { prepareManifest } from '@/config';

const prepared = await prepareManifest({
  repo: {
    url: 'https://github.com/sunny-bakery/private-site',
    token: process.env.GITHUB_TOKEN,
  },
});
try {
  const workspace = await this.sandbox.openSandbox(prepared, {
    computer: 'docker',
  });
  // The workspace now owns a copy of the repository.
} finally {
  await prepared.dispose();
}
```

Use an HTTPS URL and a read-only token. `prepareManifest` also isolates anonymous clones and Git entries supplied through `entries`. It does not inherit the server's Git credentials, credential helpers, or Git configuration. Tokens stay out of manifests, command arguments, clone URLs, `.git/config`, saved state, and surfaced errors.

Preparation requires Git and a writable `.msagents/` directory under the app's working directory. Temporary source files are private and excluded from Git and Docker build contexts. Keep them until `openSandbox(prepared)` finishes creating the files and links, then dispose them in `finally`. Unsafe, absolute, broken, or escaping links are rejected during preparation. When using the SDK client directly, call `await prepared.materialize(workspace)` immediately after `client.create({ manifest: prepared.manifest })`; close the workspace if that step fails. For prepared repositories, use `runSandbox` with the opened workspace, or `asTool({ workspace })`. `runSandboxOnce` always creates a fresh workspace and does not accept a prepared object. Prepare again before creating a fresh workspace from a disposed manifest. Existing workspace copies remain usable. SDK snapshots do not consistently preserve symlinks across providers; use retained provider storage for repositories that depend on links, or prepare and materialize them again in a fresh workspace. Do not assume a generic snapshot retains Git file metadata. After an unclean process exit, remove abandoned preparation directories only when no active preparation uses them.

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

| `computer`                                                  | What it is                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `unix` (development default)                                | Runs on this machine; rejected in production.                      |
| `docker`                                                    | A container. Uses `node:24-bookworm-slim` unless you pass `image`. |
| `modal`, `vercel`, `cloudflare`, `e2b`, `daytona`, `blaxel` | A computer in the cloud. Each reads its own login.                 |

Production has no default: pass `computer` or `client`, or you get a clear error. The app's own container usually cannot reach Docker (Coolify does not give it access), so a cloud computer such as `modal` or `e2b` is the simple choice there. Local executors are for development only.

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
<summary><h2>🖥️ Self-hosted</h2></summary>

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

| Provider       | Set up                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`        | Nothing. The executor starts on this machine.                                                                                                      |
| `aws`          | `AWS_MICROVM_IMAGE_ARN`, `AWS_MICROVM_SECRET_ARN`, and AWS CLI login. The image's `/run` hook reads `environmentId`, `remoteUrl`, and `secretArn`. |
| `digitalocean` | `DIGITALOCEAN_TOKEN`.                                                                                                                              |
| `databricks`   | `DATABRICKS_HOST` (an `https` address) and `DATABRICKS_TOKEN`. The computer is named after the session, so a retry reuses it.                      |
| `oci`          | Deploy your OCI provisioning gateway, then set `OCI_SANDBOX_PROJECT_ID`, `OCI_SANDBOX_TOKEN`, and `OCI_SANDBOX_CREATE_URL` as described below.     |

The OCI adapter connects to an application-managed provisioning gateway; it does not call Oracle’s native sandbox API directly. `OCI_SANDBOX_CREATE_URL` must be an HTTPS gateway endpoint, and `OCI_SANDBOX_TOKEN` is its bearer credential, not an Oracle security token. The gateway owns the native OCI authentication and beta SDK setup described in the [official OCI guide](https://developers.openai.com/api/docs/guides/agents-api/environments/providers/oci).

The gateway contract is:

- `POST` receives `projectId`, `displayName`, `sessionId`, `environmentId`, `remoteUrl`, and the restricted `executorKey` as JSON. Keep the key confidential and use it only as `CODEX_API_KEY` inside that sandbox.
- `Idempotency-Key` is a SHA-256 digest of the session and environment ids. Repeated requests must identify the same sandbox and must not launch a second executor.
- Wait for the OCI sandbox to reach `RUNNING`, prepare its workspace, install Codex, and launch `codex exec-server` for that environment. Return `{ id, status: 'ready', sessionId, environmentId }` only after successful setup. A known id with incomplete or mismatched setup enters reconciliation.
- `DELETE <endpoint>/<encoded-id>` must stop and delete that sandbox. Repeating deletion must succeed or return `404`. Redirects are rejected so credentials never follow a redirect to another service.

DigitalOcean provisioning sends a JSON envelope containing the YAML manifest and its variables. Databricks setup runs separate shell statements before starting the detached executor. Each command must report successful completion and exit code zero; HTTP 200 alone does not mark the machine ready. A failure retains its machine id for reconciliation. Provider contract tests run without cloud credentials; deploy-time smoke tests must still verify the executor connects and completes a real turn.

The webhook needs `DATABASE_URL`. It verifies the signature and inserts a deduplicated event in `hosted_webhooks` before acknowledging it. Provider work runs in a background worker, which starts when both `DATABASE_URL` and `OPENAI_WEBHOOK_SECRET` are configured. It starts as soon as this server stores an event, and checks every 5 seconds for events other servers stored. Each pass processes up to 20 events with at most four workers. A worker claims its next event only when it is available to process it, so slow provisioning does not block all unrelated environments.

- Duplicate deliveries share one event id. Database leases and per-environment locks coordinate replicas.
- Retryable worker failures stay queued with bounded exponential backoff. An expired five-minute worker lease can be reclaimed after a crash; an active worker renews it.
- Environment expiry is kept forever in `expired_environments`, so a late event never starts that environment again. Cleanup is coordinated with provisioning, including events arriving while a machine is being created.
- Finished events are deleted after 7 days. Until then they drop repeat deliveries from OpenAI.
- A known machine that is still awaiting connection gets a two-minute startup grace period; a later connection request stays queued during that grace period. Missing local executors and expired grace periods require operator inspection.
- Unknown provider outcomes enter `reconciliation`. The worker does not blindly create another machine when the first request may have succeeded.
- Failed cleanup preserves the machine id for retry. Local executor ids include their owning process; another replica cannot silently claim to have stopped them.

After checking the provider, reconcile an uncertain operation with either its known provider-prefixed id or confirmed absence:

```typescript
await this.sandbox.reconcileRemoteMachine(sessionId, {
  machineId: 'digitalocean:actual-provider-id',
});
// OR, only after verifying that no machine exists:
await this.sandbox.reconcileRemoteMachine(sessionId, { absent: true });
```

Reconciliation requeues the associated events. Keep `expired_environments` and the machine rows marked deleted; removing them would let a delayed event start a machine again. Monitor pending-event age, retries, and `reconciliation` records. The worker logs queue-access failures without logging credentials or webhook bodies.

</details>

<details>
<summary><h2>💚 Health checks</h2></summary>

- `GET /v1/health/live` says the app is running.
- `GET /v1/health/ready` checks memory and queries PostgreSQL when `DATABASE_URL` is configured. It returns 503 if the configured database is unavailable.

Both also work on version 2, like `/v2/health/live`. Liveness has no external dependencies. Without `DATABASE_URL`, readiness reports the database as disabled; storage features remain unavailable.

</details>

<details>
<summary><h2>✅ Verification</h2></summary>

All tests are in `test/`. Unit tests use controlled dependencies; integration tests exercise the real Agents SDK with an offline model and a disposable PostgreSQL database.

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run test:e2e
bun run test:cov
bun run build
```

Run database tests only against an isolated test database. `TEST_DATABASE_URL` is mandatory; the suite never falls back to the application database.

```bash
export TEST_DATABASE_URL=postgresql://agentic_test:agentic_test@127.0.0.1:55439/agentic_test
DATABASE_URL="$TEST_DATABASE_URL" bun run db:deploy
bun run test:integration
```

The suite covers cross-worker exclusion, connection-loss recovery, idempotent history writes, transactional suffix replacement, and approval resumption after service reconstruction, and the ChatKit server over real HTTP: streaming, privacy between users, uploads, signed file links, and approvals. It uses no paid model calls. Live provider behavior and workload latency still require environment-specific tests.

</details>

<details>
<summary><h2>🐳 Container deployment</h2></summary>

Build one image and run it anywhere that runs containers, like Docker, Kubernetes, ECS, Cloud Run, Fly.io, Railway, or Render:

```bash
docker build --tag agentic:local .
docker run --rm --read-only --tmpfs /tmp --tmpfs /app/.msagents:uid=1000,gid=1000,mode=0700 --publish 3000:3000 agentic:local
```

The image uses pinned Bun and Node versions, has only production packages, and runs as the `node` user, not as root.

On start, the image applies new database migrations, then starts the app (see Database). Give it `DATABASE_URL` and nothing else is needed:

```bash
docker run --rm --read-only --tmpfs /tmp --tmpfs /app/.msagents:uid=1000,gid=1000,mode=0700 --publish 3000:3000 \
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

`.github/workflows/ci.yml` runs for pull requests and pushes to `main` and `dev`. It installs the exact lockfile, checks formatting, lint, and types, runs unit, end-to-end, and PostgreSQL tests, checks packages for known problems, builds the app and the image, and scans the image. One job does all of it, so the runner is set up once.

- **Same everywhere.** Bun's version comes from `packageManager` in `package.json`. Every outside action is pinned to an exact commit.
- **Tests need no secrets.** End-to-end tests use a fake OpenAI key and ignore your `.env` database and Langfuse settings, so they pass the same on a laptop and in CI.
- **Cheap.** Bun packages, image layers, and the vulnerability database are cached. A newer push cancels the older run on the same branch. A push that only changes `README.md`, `docs/`, or editor guidance skips CI; production prompt Markdown changes run CI, and pull requests always run.

When a package deep inside the tree pins a version with a known problem, `overrides` in `package.json` forces the fixed version. Today that is `zod` and `js-yaml`. Remove an override once the package that pins it ships a fix.

`.github/workflows/release.yml` runs when you push a version tag. It runs the whole CI workflow first, then publishes images for Linux AMD64 and ARM64 to GitHub Container Registry, with a list of what is inside (SBOM) and a signed record of how it was built. Set up protection rules and reviewers on the `production` environment before your first release.

```bash
git tag v1.0.0
git push origin v1.0.0
```

</details>

<details>
<summary><h2>🛡️ Reliability and state</h2></summary>

Chats, approval checkpoints, webhook events, and provider identities are stored in PostgreSQL. Active model calls, child processes, and live sandbox handles are runtime resources; persistence does not make them restart automatically.

| Operation               | Guarantee                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Chat turn               | A lock row in `execution_locks` keeps other app workers out of the same chat until execution and persistence finish.              |
| SDK history transaction | The operation id and history change commit together; repeating the same operation does not append duplicate items.                |
| Approval resume         | A versioned checkpoint is claimed before execution and updated on completion; ambiguous outcomes require reconciliation.          |
| Webhook processing      | Durable inbox, retry schedule, expiring leases, and environment locks prevent lost acknowledgements and overlapping provisioning. |
| Provider cleanup        | Known machine ids and terminal records survive failed cleanup and worker restarts.                                                |

Database transactions are short and never span a model or provider call. External actions cannot be committed atomically with PostgreSQL: use stable idempotency keys or compensating actions in tools, and reconcile unknown results before retrying. A normal run interrupted before reaching a saved checkpoint must be inspected by the application; this is not a general-purpose durable workflow engine.

Execution leases use expiring rows, so model and provider calls do not hold database connections. The worker renews its leases every 15 seconds; a crashed worker’s leases expire after 60 seconds. An independent deadline aborts work when renewal cannot complete in time. History, checkpoint, and coordinated machine writes verify the lease owner and expiry while locking that row inside the same short database transaction. A stale worker cannot commit those writes after a takeover, even before its cancellation callback runs. Database pool capacity still limits concurrent queries. Custom tools must honor cancellation and independently enforce idempotency; the database fence cannot roll back an external side effect.

**Deployment:** drain old workers before applying schema changes and starting this version. Apply the system-prompt revision and Composio creation-intent migrations with `bun run db:deploy`, and regenerate the Prisma client with `bun run db:generate` (also run by install). Old clients that write a literal prompt version bypass the new sequence. Existing Composio mappings become `ready`; interrupted new creations require the reconciliation described above. Older binaries do not participate in the new execution locks or inbox. The migration preserves data and marks legacy consumed approvals and incomplete machine claims for reconciliation. Back up production data and inspect these records after deployment; do not replay them automatically.

Run-owned traces finish on both success and failure, including streaming failures. Langfuse keeps separate input/output notes for each run within a shared workflow, records the resolved model on each OpenAI request after handoffs, and counts cached input in a non-overlapping token bucket. Chat Completions requests retain one billable generation with the resolved model and usage, including streaming and retry paths. Failed attempts remain visible without counting successful usage again. Unknown custom-model identities are not assigned an invented price. The Agents SDK's built-in tracing remains enabled. Model and tool payloads stay off each trace unless `TRACE_PAYLOADS` or a run's `tracePayloads` flag turns them on for grading. Use the returned result's `runContext.usage` for token accounting, and correlate application request ids with run/chat ids in your own telemetry. Define task-specific evaluation datasets and measure latency and cost on representative workloads before making performance claims. Retention and authorization policies belong to the application; authenticate before loading a chat or deciding an approval.

Sandbox files require their own retained workspace, provider storage, or snapshot. Keep executor credentials separate from application credentials, and use isolated compute for untrusted code. Shutdown cancels run signals, closes cached WebSocket providers, and stops locally owned executors; interrupted external operations remain subject to reconciliation.

</details>

## 📘 NestJS guidance applied

This project follows the NestJS guides for [exception filters](https://docs.nestjs.com/exception-filters), [security headers](https://docs.nestjs.com/techniques/security/cors), [CSRF protection](https://docs.nestjs.com/security/csrf), [validation](https://docs.nestjs.com/application/validation), [rate limiting](https://docs.nestjs.com/security/rate-limiting), and [shutdown hooks](https://docs.nestjs.com/fundamentals/lifecycle-events).

## ⭐ Acknowledgments

This Nestjs-OpenAI Agents SDK boilerplate was created by [Abolade Greatness](https://github.com/grtsnx).

Follow on [GitHub](https://github.com/grtsnx) and star [nestyagent](https://github.com/grtsnx/nestyagent).

- [X](https://x.com/grtsnx)
- [LinkedIn](https://www.linkedin.com/in/grtsnx)
- [grtsnx.com](https://grtsnx.com)
