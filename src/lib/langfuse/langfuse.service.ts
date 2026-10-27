import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SpanContext } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import {
  addTraceProcessor,
  type Span,
  type SpanData,
  type Trace,
  type TracingProcessor,
} from '@openai/agents';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
  startObservation,
} from '@langfuse/tracing';

// One Agents SDK trace or span, reduced to the fields the Langfuse plan reads.
export type AgentTraceItem =
  | {
      type: 'trace';
      traceId: string;
      name: string;
      groupId: string | null;
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'trace.span';
      traceId: string;
      spanId: string;
      parentId: string | null;
      spanData: SpanData;
      error: { message: string } | null;
      startedAt: string | null;
      endedAt: string | null;
    };

// What one customer turn should show, without tool arguments or model payloads.
export type TurnNote = {
  input?: unknown;
  output?: unknown;
  sessionId?: string;
  userId?: string;
  requestId?: string;
  model?: string;
  agent?: string;
};

export type ObservationType =
  'span' | 'generation' | 'agent' | 'tool' | 'chain' | 'guardrail';

// One Langfuse observation to create, parent before child.
export type PlannedObservation = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  asType: ObservationType;
  input?: unknown;
  output?: unknown;
  model?: string;
  usageDetails?: {
    input?: number;
    output?: number;
    input_cached_tokens?: number;
  };
  metadata: Record<string, string>;
  sessionId?: string;
  userId?: string;
  tags?: string[];
  level?: 'ERROR';
  statusMessage?: string;
  startTime?: Date;
  endTime?: Date;
};

//1. One completed Agents SDK trace segment becomes one Langfuse trace.
//2. Native model generations carry cost and tokens; a turn supplies the fallback.
//3. A tool, guardrail, or handoff keeps its own type and sits beside that generation.
export function planObservations(
  items: AgentTraceItem[],
  notes: ReadonlyMap<string, TurnNote>,
): PlannedObservation[] {
  const traces = new Map<string, Extract<AgentTraceItem, { type: 'trace' }>>();
  const spans = items.flatMap((item) => {
    if (item.type === 'trace') {
      traces.set(item.traceId, item);
      return [];
    }
    if (!item.spanId || item.spanId === 'no-op') return [];
    return [item];
  });
  const byId = new Map(spans.map((item) => [item.spanId, item]));
  const generationsByTurn = new Map<string, (typeof spans)[number][]>();
  for (const item of spans) {
    if (item.spanData.type !== 'generation') continue;
    const seen = new Set([item.spanId]);
    let parent = item.parentId && byId.get(item.parentId);
    while (parent && !seen.has(parent.spanId)) {
      if (parent.spanData.type === 'turn') {
        const children = generationsByTurn.get(parent.spanId) ?? [];
        children.push(item);
        generationsByTurn.set(parent.spanId, children);
        break;
      }
      seen.add(parent.spanId);
      parent = parent.parentId && byId.get(parent.parentId);
    }
  }
  const usageFallbacks = new Map<string, Parameters<typeof usageOf>[0]>();
  for (const [turnId, generations] of generationsByTurn) {
    const turn = byId.get(turnId)?.spanData;
    if (turn?.type !== 'turn' || !turn.usage) continue;
    const missing = generations.filter(
      (item) =>
        item.spanData.type === 'generation' &&
        !item.spanData.usage &&
        !item.error,
    );
    // The SDK puts successful Chat Completions usage on the enclosing turn.
    // After a retry, subtract reported failed usage before assigning the rest
    // to its single successful call. Never copy a turn total onto every child.
    const target =
      generations.length === 1
        ? generations[0]
        : missing.length === 1
          ? missing[0]
          : undefined;
    if (!target) continue;
    const remaining = { ...turn.usage };
    for (const item of generations) {
      if (item.spanData.type !== 'generation' || !item.spanData.usage) continue;
      const usage = item.spanData.usage;
      remaining.input_tokens -= usage.input_tokens ?? 0;
      remaining.output_tokens -= usage.output_tokens ?? 0;
      remaining.cached_input_tokens -=
        usageOf(usage).usageDetails?.input_cached_tokens ?? 0;
    }
    usageFallbacks.set(target.spanId, {
      input_tokens: Math.max(0, remaining.input_tokens),
      output_tokens: Math.max(0, remaining.output_tokens),
      cached_input_tokens: Math.max(0, remaining.cached_input_tokens),
    });
  }
  const ordered = spans
    .slice()
    .sort((left, right) => depth(left) - depth(right));
  const planned: PlannedObservation[] = [];
  const seenGenerations = new Map<string, number>();

  for (const item of ordered) {
    const trace = traces.get(item.traceId);
    const ancestors = [item];
    const seen = new Set([item.spanId]);
    let parent = item.parentId && byId.get(item.parentId);
    while (parent && !seen.has(parent.spanId)) {
      ancestors.push(parent);
      seen.add(parent.spanId);
      parent = parent.parentId && byId.get(parent.parentId);
    }
    const note = Object.assign(
      {},
      notes.get(item.traceId),
      ...ancestors.toReversed().map((ancestor) => notes.get(ancestor.spanId)),
    ) as TurnNote;
    const runId =
      ancestors.find((ancestor) => ancestor.spanData.type === 'task')?.spanId ??
      item.traceId;
    const mapped = mapSpan(
      item,
      trace,
      note,
      seenGenerations,
      runId,
      generationsByTurn.has(item.spanId),
      usageFallbacks.get(item.spanId),
    );
    if (!mapped) continue;
    const parentId = item.parentId;
    planned.push({
      ...mapped,
      traceId: item.traceId,
      spanId: item.spanId,
      // The SDK's own times, so Langfuse shows how long each step really took.
      ...(item.startedAt && { startTime: new Date(item.startedAt) }),
      ...(item.endedAt && { endTime: new Date(item.endedAt) }),
      ...(parentId && byId.has(parentId) ? { parentSpanId: parentId } : {}),
    });
  }
  return planned;

  function depth(
    item: Extract<AgentTraceItem, { type: 'trace.span' }>,
  ): number {
    let count = 0;
    let parentId = item.parentId;
    const seen = new Set<string>([item.spanId]);
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      count += 1;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return count;
  }
}

function mapSpan(
  item: Extract<AgentTraceItem, { type: 'trace.span' }>,
  trace: Extract<AgentTraceItem, { type: 'trace' }> | undefined,
  note: TurnNote | undefined,
  seenGenerations: Map<string, number>,
  runId: string,
  hasNativeGenerations: boolean,
  usageFallback: Parameters<typeof usageOf>[0],
):
  | Omit<
      PlannedObservation,
      'traceId' | 'spanId' | 'parentSpanId' | 'startTime' | 'endTime'
    >
  | undefined {
  const data = item.spanData;
  const metadata = stringMetadata(trace?.metadata);
  if (note?.requestId) metadata.request_id = note.requestId;
  if (note?.agent) metadata.agent = note.agent;
  if (note?.sessionId) metadata.session_id = note.sessionId;
  if (note?.userId) metadata.user_id = note.userId;
  const failed = item.error
    ? { level: 'ERROR' as const, statusMessage: item.error.message }
    : {};

  switch (data.type) {
    case 'task':
      return {
        name: 'run-agent',
        asType: 'span',
        ...(note?.input !== undefined && { input: note.input }),
        ...(note?.output !== undefined && { output: note.output }),
        metadata,
        ...(note?.sessionId || trace?.groupId
          ? { sessionId: note?.sessionId ?? trace?.groupId ?? undefined }
          : {}),
        ...(note?.userId && { userId: note.userId }),
        tags: ['agent'],
        ...failed,
      };
    case 'agent':
      return { name: data.name, asType: 'agent', metadata, ...failed };
    case 'turn': {
      const index = seenGenerations.get(runId) ?? 0;
      seenGenerations.set(runId, index + 1);
      return {
        name: hasNativeGenerations ? 'model-turn' : 'generate-response',
        asType: hasNativeGenerations ? 'span' : 'generation',
        ...(!hasNativeGenerations && usageOf(data.usage)),
        ...(!hasNativeGenerations && note?.model && { model: note.model }),
        ...(index === 0 && note?.input !== undefined && { input: note.input }),
        metadata: {
          ...metadata,
          turn: String(data.turn),
          ...(data.agent_name && { agent_name: data.agent_name }),
        },
        ...failed,
      };
    }
    case 'generation':
      return {
        name: 'generate-response',
        asType: 'generation',
        ...(data.model && { model: data.model }),
        ...usageOf(data.usage ?? usageFallback),
        ...(data.input !== undefined && { input: data.input }),
        ...(data.output !== undefined && { output: data.output }),
        metadata,
        ...failed,
      };
    case 'function':
      return {
        name: data.name,
        asType: 'tool',
        ...(data.input ? { input: data.input } : {}),
        ...(data.output ? { output: data.output } : {}),
        metadata,
        ...failed,
      };
    case 'handoff':
      return {
        name: 'handoff',
        asType: 'chain',
        metadata: {
          ...metadata,
          ...(data.from_agent && { from_agent: data.from_agent }),
          ...(data.to_agent && { to_agent: data.to_agent }),
        },
        ...failed,
      };
    case 'guardrail':
      return {
        name: data.name,
        asType: 'guardrail',
        metadata: { ...metadata, triggered: String(data.triggered) },
        ...failed,
      };
    case 'mcp_tools':
      return {
        name: 'list-mcp-tools',
        asType: 'tool',
        ...(data.result && { output: data.result }),
        metadata: {
          ...metadata,
          ...(data.server && { server: data.server }),
        },
        ...failed,
      };
    case 'custom':
      return {
        name: data.name,
        asType: 'span',
        metadata: { ...metadata, ...stringMetadata(data.data) },
        ...failed,
      };
    case 'response':
      return {
        name: 'record-response',
        asType: 'span',
        metadata: {
          ...metadata,
          ...(data.response_id && { response_id: data.response_id }),
        },
        ...failed,
      };
    case 'transcription':
      return {
        name: 'transcribe-audio',
        asType: 'span',
        ...(data.output && { output: data.output }),
        metadata,
        ...failed,
      };
    case 'speech':
      return { name: 'synthesize-speech', asType: 'span', metadata, ...failed };
    case 'speech_group':
      return { name: 'group-speech', asType: 'span', metadata, ...failed };
    default:
      return undefined;
  }
}

function usageOf(usage?: {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}) {
  if (!usage) return {};
  const details: {
    input?: number;
    output?: number;
    input_cached_tokens?: number;
  } = {};
  const cached =
    usage.cached_input_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
  // OpenAI includes cache hits in input; Langfuse expects exclusive buckets.
  if (usage.input_tokens !== undefined)
    details.input = Math.max(0, usage.input_tokens - cached);
  if (usage.output_tokens !== undefined) details.output = usage.output_tokens;
  if (cached) details.input_cached_tokens = cached;
  return Object.keys(details).length ? { usageDetails: details } : {};
}

function stringMetadata(value: Record<string, unknown> | undefined) {
  const metadata: Record<string, string> = {};
  if (!value) return metadata;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry) metadata[key] = entry;
    else if (typeof entry === 'number' || typeof entry === 'boolean')
      metadata[key] = String(entry);
  }
  return metadata;
}

type Opened = {
  otelSpan: {
    setAttribute(key: string, value: string | string[]): void;
    spanContext(): SpanContext;
  };
  end(endTime?: Date): void;
};

//1. Off until the public key, secret, and base URL are all set.
//2. Test runs never export, so the suite does not talk to Langfuse.
//3. Each completed SDK trace segment is sent after the turn records its answer.
@Injectable()
export class LangfuseService
  implements OnModuleInit, OnModuleDestroy, TracingProcessor
{
  private readonly notes = new Map<string, TurnNote>();
  private readonly runNote = new AsyncLocalStorage<TurnNote>();
  private readonly pending = new Map<string, AgentTraceItem[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly logger = new Logger(LangfuseService.name);
  private processor?: LangfuseSpanProcessor;
  private provider?: BasicTracerProvider;

  constructor(private readonly config: ConfigService) {}

  get enabled() {
    return (
      this.config.get<string>('NODE_ENV') !== 'test' &&
      this.config.get<boolean>('LANGFUSE_ENABLED') === true
    );
  }

  onModuleInit() {
    if (!this.enabled) return;
    const processor = new LangfuseSpanProcessor({
      publicKey: this.config.get<string>('LANGFUSE_PUBLIC_KEY'),
      secretKey: this.config.get<string>('LANGFUSE_SECRET_KEY'),
      baseUrl: this.config.get<string>('LANGFUSE_BASE_URL'),
      environment: this.config.get<string>('NODE_ENV'),
      mask: ({ data }) => maskSecrets(data),
      shouldExportSpan: ({ otelSpan }) =>
        typeof otelSpan.attributes['langfuse.observation.type'] === 'string',
    });
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    setLangfuseTracerProvider(provider);
    this.processor = processor;
    this.provider = provider;
    addTraceProcessor(this);
  }

  // A Langfuse outage must not block the app from stopping. Unsent traces are dropped.
  async onModuleDestroy() {
    await this.shutdown().catch(() =>
      this.logger.warn('Langfuse was unreachable; unsent traces were dropped.'),
    );
  }

  // Merge context into the active run, or the trace when called outside a run.
  note(traceId: string, patch: Partial<TurnNote>) {
    if (!this.enabled) return;
    const current = this.runNote.getStore();
    const next: TurnNote = current ?? { ...this.notes.get(traceId) };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) next[key as keyof TurnNote] = value as never;
    }
    if (!current) this.notes.set(traceId, next);
  }

  // Each Runner invocation owns its input and output, even inside a shared workflow.
  withRun<T>(note: TurnNote, callback: () => T): T {
    return this.runNote.run({ ...note }, callback);
  }

  // A model provider records the resolved model on the current SDK turn span.
  noteSpan(spanId: string, patch: Partial<TurnNote>) {
    if (!this.enabled) return;
    this.notes.set(spanId, { ...this.notes.get(spanId), ...patch });
  }

  async onTraceStart() {}

  async onSpanStart(span: Span<SpanData>) {
    const note = this.runNote.getStore();
    if (note && span.spanData.type === 'task')
      this.notes.set(span.spanId, note);
  }

  async onSpanEnd(span: Span<SpanData>) {
    this.remember({
      type: 'trace.span',
      traceId: span.traceId,
      spanId: span.spanId,
      parentId: span.parentId,
      spanData: span.spanData,
      error: span.error,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
    });
  }

  async onTraceEnd(trace: Trace) {
    this.remember({
      type: 'trace',
      traceId: trace.traceId,
      name: trace.name,
      groupId: trace.groupId,
      metadata: trace.metadata,
    });
    const existing = this.timers.get(trace.traceId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => this.publish(trace.traceId), 0);
    timer.unref();
    this.timers.set(trace.traceId, timer);
  }

  async forceFlush() {
    // Deleting the current key while iterating a Map is safe.
    for (const traceId of this.pending.keys()) this.publish(traceId);
    await this.processor?.forceFlush();
  }

  // The provider always shuts down, even when the last flush fails.
  async shutdown(timeout?: number) {
    try {
      await this.forceFlush();
    } finally {
      await this.provider?.shutdown();
    }
    void timeout;
  }

  private remember(item: AgentTraceItem) {
    const list = this.pending.get(item.traceId) ?? [];
    list.push(item);
    this.pending.set(item.traceId, list);
  }

  private publish(traceId: string) {
    const items = this.pending.get(traceId);
    if (!items?.length) return;
    this.pending.delete(traceId);
    const timer = this.timers.get(traceId);
    if (timer) clearTimeout(timer);
    this.timers.delete(traceId);
    const planned = planObservations(items, this.notes);
    const trace = items.find((item) => item.type === 'trace');
    const traceName = trace?.type === 'trace' ? trace.name : 'agent-turn';
    const roots = planned.filter((observation) => !observation.parentSpanId);
    if (roots.length > 1) {
      const rootId = `workflow:${traceId}`;
      const starts = roots.flatMap((item) =>
        item.startTime ? [item.startTime.getTime()] : [],
      );
      const ends = roots.flatMap((item) =>
        item.endTime ? [item.endTime.getTime()] : [],
      );
      for (const root of roots) root.parentSpanId = rootId;
      // Workflow context belongs to its root; each run keeps its own metadata.
      for (const observation of planned) delete observation.tags;
      const sessionId = roots.find((item) => item.sessionId)?.sessionId;
      const userId = roots.find((item) => item.userId)?.userId;
      planned.unshift({
        traceId,
        spanId: rootId,
        name: traceName,
        asType: 'span',
        input: roots
          .filter((item) => item.input !== undefined)
          .map((item) => item.input),
        output: roots
          .filter((item) => item.output !== undefined)
          .map((item) => item.output),
        metadata: { ...stringMetadata(trace?.metadata), sdk_trace_id: traceId },
        tags: ['agent'],
        ...(sessionId &&
          roots.every(
            (item) => !item.sessionId || item.sessionId === sessionId,
          ) && { sessionId }),
        ...(userId &&
          roots.every((item) => !item.userId || item.userId === userId) && {
            userId,
          }),
        ...(starts.length && { startTime: new Date(Math.min(...starts)) }),
        ...(ends.length && { endTime: new Date(Math.max(...ends)) }),
      });
    }
    const opened = new Map<string, Opened>();
    for (const observation of planned) {
      const parent = observation.parentSpanId
        ? opened.get(observation.parentSpanId)
        : undefined;
      const created = openObservation(parent, observation);
      if (observation.tags) {
        created.otelSpan.setAttribute(
          LangfuseOtelSpanAttributes.TRACE_NAME,
          traceName,
        );
        if (observation.sessionId) {
          created.otelSpan.setAttribute(
            LangfuseOtelSpanAttributes.TRACE_SESSION_ID,
            observation.sessionId,
          );
          created.otelSpan.setAttribute(
            LangfuseOtelSpanAttributes.TRACE_COMPAT_SESSION_ID,
            observation.sessionId,
          );
        }
        if (observation.userId) {
          created.otelSpan.setAttribute(
            LangfuseOtelSpanAttributes.TRACE_USER_ID,
            observation.userId,
          );
          created.otelSpan.setAttribute(
            LangfuseOtelSpanAttributes.TRACE_COMPAT_USER_ID,
            observation.userId,
          );
        }
        created.otelSpan.setAttribute(
          LangfuseOtelSpanAttributes.TRACE_TAGS,
          observation.tags,
        );
        for (const key of ['request_id', 'agent'] as const) {
          const value = observation.metadata[key];
          if (value)
            created.otelSpan.setAttribute(
              `${LangfuseOtelSpanAttributes.TRACE_METADATA}.${key}`,
              value,
            );
        }
      }
      created.end(observation.endTime);
      opened.set(observation.spanId, created);
    }
    this.notes.delete(traceId);
    for (const item of items) {
      if (item.type === 'trace.span') this.notes.delete(item.spanId);
    }
  }
}

function openObservation(
  parent: Opened | undefined,
  observation: PlannedObservation,
): Opened {
  const attributes = {
    ...(observation.input !== undefined && { input: observation.input }),
    ...(observation.output !== undefined && { output: observation.output }),
    ...(observation.model && { model: observation.model }),
    ...(observation.usageDetails && { usageDetails: observation.usageDetails }),
    ...(observation.level && { level: observation.level }),
    ...(observation.statusMessage && {
      statusMessage: observation.statusMessage,
    }),
    metadata: observation.metadata,
  };
  // The top-level call is the one that takes a start time, so the parent is linked by context.
  return (
    startObservation as (
      name: string,
      attributes: Record<string, unknown>,
      options: {
        asType: ObservationType;
        startTime?: Date;
        parentSpanContext?: SpanContext;
      },
    ) => Opened
  )(observation.name, attributes, {
    asType: observation.asType,
    ...(observation.startTime && { startTime: observation.startTime }),
    ...(parent && { parentSpanContext: parent.otelSpan.spanContext() }),
  });
}

function maskSecrets(data: unknown): unknown {
  if (typeof data === 'string') {
    return data
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
      .replace(/pk-lf-[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/sk-lf-[A-Za-z0-9_-]+/g, '[redacted]');
  }
  if (Array.isArray(data)) return data.map(maskSecrets);
  if (data && typeof data === 'object')
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, maskSecrets(value)]),
    );
  return data;
}
