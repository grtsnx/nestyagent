import { Logger } from '@nestjs/common';
import {
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  tool,
  type AgentInputItem,
  type RunContext,
  type RunStreamEvent,
  type Tool,
} from '@openai/agents';
import { randomUUID } from 'node:crypto';
import {
  type Action,
  type ActionConfig,
  type ActionHandler,
  type Annotation,
  type AssistantMessageContent,
  type AssistantMessageItem,
  type Attachment,
  type AttachmentCreateParams,
  type AudioInput,
  type ChatKitReq,
  type ClientToolCallItem,
  CustomStreamError,
  type EndOfTurnItem,
  ErrorCode,
  type FeedbackKind,
  type GeneratedImageItem,
  type HiddenContextItem,
  type IconName,
  isHiddenItem,
  isStreamingReq,
  type LoadingBehavior,
  type NonStreamingReq,
  NotFoundError,
  type Page,
  REQUEST_TYPES,
  type SDKHiddenContextItem,
  StreamError,
  type StreamingReq,
  type StreamOptions,
  type StructuredInputItem,
  type StructuredInputSubmission,
  type SyncCustomActionResponse,
  type Task,
  type TaskItem,
  type ThoughtTask,
  type Thread,
  type ThreadItem,
  type ThreadItemUpdate,
  type ThreadMetadata,
  type ThreadStreamEvent,
  type TranscriptionResult,
  type UserMessageInput,
  type UserMessageItem,
  type UserMessageTagContent,
  type WidgetItem,
  type WidgetRoot,
  type Workflow,
  type WorkflowItem,
  type WorkflowSummary,
} from './chatkit.types.js';

export * from './chatkit.types.js';

export type StoreItemType =
  | 'thread'
  | 'message'
  | 'tool_call'
  | 'task'
  | 'workflow'
  | 'attachment'
  | 'sdk_hidden_context';

const ID_PREFIXES: Record<StoreItemType, string> = {
  thread: 'thr',
  message: 'msg',
  tool_call: 'tc',
  workflow: 'wf',
  task: 'tsk',
  attachment: 'atc',
  sdk_hidden_context: 'shcx',
};

// The full random UUID, not 8 characters, so ids never collide across users.
export function defaultGenerateId(itemType: StoreItemType) {
  return `${ID_PREFIXES[itemType]}_${randomUUID().replaceAll('-', '')}`;
}

export type Order = 'asc' | 'desc';

//1. Threads, items, and attachment metadata. Every method gets the request context.
//2. Use the context to scope every read and write to its user, or one user can read another's chat.
export abstract class Store<TContext> {
  generateThreadId(_context: TContext) {
    return defaultGenerateId('thread');
  }

  generateItemId(
    itemType: StoreItemType,
    _thread: ThreadMetadata,
    _context: TContext,
  ) {
    return defaultGenerateId(itemType);
  }

  abstract loadThread(
    threadId: string,
    context: TContext,
  ): Promise<ThreadMetadata>;
  abstract saveThread(thread: ThreadMetadata, context: TContext): Promise<void>;
  abstract loadThreadItems(
    threadId: string,
    after: string | null,
    limit: number,
    order: Order,
    context: TContext,
  ): Promise<Page<ThreadItem>>;
  abstract saveAttachment(
    attachment: Attachment,
    context: TContext,
  ): Promise<void>;
  abstract loadAttachment(
    attachmentId: string,
    context: TContext,
  ): Promise<Attachment>;
  abstract deleteAttachment(
    attachmentId: string,
    context: TContext,
  ): Promise<void>;
  abstract loadThreads(
    limit: number,
    after: string | null,
    order: Order,
    context: TContext,
  ): Promise<Page<ThreadMetadata>>;
  abstract addThreadItem(
    threadId: string,
    item: ThreadItem,
    context: TContext,
  ): Promise<void>;
  abstract saveItem(
    threadId: string,
    item: ThreadItem,
    context: TContext,
  ): Promise<void>;
  abstract loadItem(
    threadId: string,
    itemId: string,
    context: TContext,
  ): Promise<ThreadItem>;
  abstract deleteThread(threadId: string, context: TContext): Promise<void>;
  abstract deleteThreadItem(
    threadId: string,
    itemId: string,
    context: TContext,
  ): Promise<void>;
}

// File bytes. Required for attachments; ChatKitService calls it before Store.deleteAttachment.
export abstract class AttachmentStore<TContext> {
  abstract deleteAttachment(
    attachmentId: string,
    context: TContext,
  ): Promise<void>;

  // Two-phase upload: return metadata with an upload_descriptor for the client to POST to.
  createAttachment(
    _input: AttachmentCreateParams,
    _context: TContext,
  ): Promise<Attachment> {
    return Promise.reject(
      new Error('Override createAttachment to support two-phase upload.'),
    );
  }

  generateAttachmentId(_mimeType: string, _context: TContext) {
    return defaultGenerateId('attachment');
  }
}

//1. Keeps everything in memory, for tests and local trials. Data is lost on restart.
//2. It ignores the context, so it is not safe for more than one user.
export class MemoryStore<TContext = unknown> extends Store<TContext> {
  private readonly threads = new Map<string, ThreadMetadata>();
  private readonly items = new Map<string, ThreadItem[]>();
  private readonly attachments = new Map<string, Attachment>();

  loadThread(threadId: string, _context?: TContext) {
    const thread = this.threads.get(threadId);
    if (!thread) return Promise.reject(new NotFoundError('Thread not found.'));
    return Promise.resolve(structuredClone(thread));
  }

  saveThread(thread: ThreadMetadata, _context?: TContext) {
    this.threads.set(thread.id, structuredClone(thread));
    return Promise.resolve();
  }

  loadThreadItems(
    threadId: string,
    after: string | null,
    limit: number,
    order: Order,
    _context?: TContext,
  ) {
    const all = [...(this.items.get(threadId) ?? [])];
    if (order === 'desc') all.reverse();
    return Promise.resolve(pageAfter(all, after, limit));
  }

  loadThreads(
    limit: number,
    after: string | null,
    order: Order,
    _context?: TContext,
  ) {
    const all = [...this.threads.values()].sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
    if (order === 'desc') all.reverse();
    return Promise.resolve(pageAfter(all, after, limit));
  }

  addThreadItem(threadId: string, item: ThreadItem, _context?: TContext) {
    return this.saveItem(threadId, item);
  }

  saveItem(threadId: string, item: ThreadItem, _context?: TContext) {
    const list = this.items.get(threadId) ?? [];
    const index = list.findIndex((existing) => existing.id === item.id);
    if (index === -1) list.push(structuredClone(item));
    else list[index] = structuredClone(item);
    this.items.set(threadId, list);
    return Promise.resolve();
  }

  loadItem(threadId: string, itemId: string, _context?: TContext) {
    const item = this.items.get(threadId)?.find((entry) => entry.id === itemId);
    if (!item) return Promise.reject(new NotFoundError('Item not found.'));
    return Promise.resolve(structuredClone(item));
  }

  deleteThread(threadId: string, _context?: TContext) {
    this.threads.delete(threadId);
    this.items.delete(threadId);
    return Promise.resolve();
  }

  deleteThreadItem(threadId: string, itemId: string, _context?: TContext) {
    const list = this.items.get(threadId) ?? [];
    this.items.set(
      threadId,
      list.filter((item) => item.id !== itemId),
    );
    return Promise.resolve();
  }

  saveAttachment(attachment: Attachment, _context?: TContext) {
    this.attachments.set(attachment.id, structuredClone(attachment));
    return Promise.resolve();
  }

  loadAttachment(attachmentId: string, _context?: TContext) {
    const attachment = this.attachments.get(attachmentId);
    if (!attachment)
      return Promise.reject(new NotFoundError('Attachment not found.'));
    return Promise.resolve(structuredClone(attachment));
  }

  deleteAttachment(attachmentId: string, _context?: TContext) {
    this.attachments.delete(attachmentId);
    return Promise.resolve();
  }
}

function pageAfter<T extends { id: string }>(
  all: T[],
  after: string | null,
  limit: number,
): Page<T> {
  const start = after ? all.findIndex((entry) => entry.id === after) + 1 : 0;
  const data = all.slice(start, start + limit);
  const hasMore = start + limit < all.length;
  return {
    data,
    has_more: hasMore,
    after: hasMore ? (data.at(-1)?.id ?? null) : null,
  };
}

type Node = Record<string, unknown> & {
  type?: string;
  id?: string;
  key?: string;
};

// The config a widget node carries. handler 'client' sends the action to the browser's onAction.
export function actionConfig(
  type: string,
  payload?: unknown,
  options: {
    handler?: ActionHandler;
    loadingBehavior?: LoadingBehavior;
    streaming?: boolean;
  } = {},
): ActionConfig {
  return {
    type,
    ...(payload !== undefined && { payload }),
    handler: options.handler ?? 'server',
    loadingBehavior: options.loadingBehavior ?? 'auto',
    streaming: options.streaming ?? true,
  };
}

function isStreamingText(node: Node) {
  return (
    (node.type === 'Markdown' || node.type === 'Text') &&
    typeof node.value === 'string'
  );
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fullReplace(before: Node, after: Node): boolean {
  if (
    before.type !== after.type ||
    before.id !== after.id ||
    before.key !== after.key
  )
    return true;
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const field of fields) {
    // Appending to a Text or Markdown value streams as a delta, not a replace.
    if (
      field === 'value' &&
      isStreamingText(before) &&
      isStreamingText(after) &&
      (after.value as string).startsWith(before.value as string)
    )
      continue;
    if (valueChanged(before[field], after[field])) return true;
  }
  return false;
}

function valueChanged(before: unknown, after: unknown): boolean {
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return true;
    return before.some((entry, index) => valueChanged(entry, after[index]));
  }
  if (isNode(before) && isNode(after) && ('type' in before || 'type' in after))
    return fullReplace(before, after);
  return JSON.stringify(before) !== JSON.stringify(after);
}

function streamingTextNodes(root: Node) {
  const found = new Map<string, Node>();
  const visit = (node: Node) => {
    if (isStreamingText(node) && node.id) found.set(node.id, node);
    const children = node.children;
    if (Array.isArray(children))
      for (const child of children) if (isNode(child)) visit(child);
  };
  visit(root);
  return found;
}

//1. The smallest set of updates that turns one widget into the next.
//2. Text and Markdown nodes with an id stream as appended deltas. Anything else replaces the root.
export function diffWidget(
  before: WidgetRoot,
  after: WidgetRoot,
): ThreadItemUpdate[] {
  const a = before as unknown as Node;
  const b = after as unknown as Node;
  if (fullReplace(a, b))
    return [{ type: 'widget.root.updated', widget: after }];
  const beforeNodes = streamingTextNodes(a);
  const deltas: ThreadItemUpdate[] = [];
  for (const [id, node] of streamingTextNodes(b)) {
    const previous = beforeNodes.get(id);
    if (!previous)
      throw new Error(
        `Node ${id} was not present when the widget was first rendered. Nodes with an id must persist across updates.`,
      );
    const from = String(previous.value);
    const to = String(node.value);
    if (from === to) continue;
    if (!to.startsWith(from))
      throw new Error(
        `Node ${id} changed to a value that does not start with its earlier value. Widget updates must be cumulative.`,
      );
    deltas.push({
      type: 'widget.streaming_text.value_delta',
      component_id: id,
      delta: to.slice(from.length),
      done: !node.streaming,
    });
  }
  return deltas;
}

//1. One widget is sent whole. A stream of widgets is sent as added, then updates, then done.
//2. generateId should use the store, so ids match the rest of the thread.
export async function* streamWidget(
  thread: ThreadMetadata,
  widget: WidgetRoot | AsyncIterable<WidgetRoot>,
  copyText?: string | null,
  generateId: (type: StoreItemType) => string = defaultGenerateId,
): AsyncGenerator<ThreadStreamEvent> {
  const base = {
    type: 'widget' as const,
    id: generateId('message'),
    thread_id: thread.id,
    created_at: new Date().toISOString(),
    ...(copyText != null && { copy_text: copyText }),
  };
  if (!isAsyncIterable(widget)) {
    yield { type: 'thread.item.done', item: { ...base, widget } };
    return;
  }
  let last: WidgetRoot | undefined;
  for await (const state of widget) {
    if (last === undefined) {
      yield { type: 'thread.item.added', item: { ...base, widget: state } };
    } else {
      for (const update of diffWidget(last, state))
        yield { type: 'thread.item.updated', item_id: base.id, update };
    }
    last = state;
  }
  if (last === undefined) return;
  const done: WidgetItem = { ...base, widget: last };
  yield { type: 'thread.item.done', item: done };
}

// Turns model text deltas into growing copies of a Text or Markdown widget, ending with streaming off.
export async function* accumulateText<T extends WidgetRoot>(
  events: AsyncIterable<RunStreamEvent>,
  baseWidget: T,
  field: (widget: T, text: string, streaming: boolean) => T,
): AsyncGenerator<T> {
  let text = '';
  yield baseWidget;
  for await (const event of events) {
    if (
      event.type === 'raw_model_stream_event' &&
      event.data.type === 'output_text_delta'
    ) {
      text += event.data.delta;
      yield field(baseWidget, text, true);
    }
  }
  yield field(baseWidget, text, false);
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === 'object' && value !== null && Symbol.asyncIterator in value
  );
}

export const DEFAULT_PAGE_SIZE = 20;

// SSE bytes for a streaming request, or one JSON body for the rest.
export type ChatKitResult =
  | { streaming: true; stream: AsyncGenerator<string> }
  | { streaming: false; json: string };

// A request the client sent that does not match the protocol.
export class InvalidRequestError extends Error {
  constructor(message = 'Invalid ChatKit request.') {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

//1. The ChatKit protocol on the server, ported from openai/chatkit-python (server.py).
//2. Subclass it and implement respond. Override action, syncAction, addFeedback, and transcribe as needed.
//3. TContext carries the signed-in user, so stores can scope every read and write.
export abstract class ChatKitService<TContext> {
  protected readonly logger = new Logger('ChatKitService');

  constructor(
    readonly store: Store<TContext>,
    readonly attachmentStore?: AttachmentStore<TContext>,
  ) {}

  // Stream the reply to a new user message. input is undefined after a tool output or structured input.
  abstract respond(
    thread: ThreadMetadata,
    input: UserMessageItem | undefined,
    context: TContext,
  ): AsyncIterable<ThreadStreamEvent>;

  // Save thumbs up or down for one or more items.
  addFeedback(
    _threadId: string,
    _itemIds: string[],
    _kind: FeedbackKind,
    _context: TContext,
  ): Promise<void> {
    return Promise.resolve();
  }

  // Turn dictated audio into composer text. Required for the input.transcribe request.
  transcribe(
    _audio: AudioInput,
    _context: TContext,
  ): Promise<TranscriptionResult> {
    return Promise.reject(
      new Error('Override transcribe to support dictation.'),
    );
  }

  // React to a widget or client-sent action. The action is untrusted: validate it.
  action(
    _thread: ThreadMetadata,
    _action: Action,
    _sender: WidgetItem | undefined,
    _context: TContext,
  ): AsyncIterable<ThreadStreamEvent> {
    throw new Error('Override action to react to widget actions.');
  }

  // React to an action and return one updated item instead of a stream.
  syncAction(
    _thread: ThreadMetadata,
    _action: Action,
    _sender: WidgetItem | undefined,
    _context: TContext,
  ): Promise<SyncCustomActionResponse> {
    return Promise.reject(
      new Error('Override syncAction to react to sync widget actions.'),
    );
  }

  // The client may cancel a stream by default.
  getStreamOptions(_thread: ThreadMetadata, _context: TContext): StreamOptions {
    return { allow_cancel: true };
  }

  //1. When the user stops a reply, keep any assistant text that already arrived.
  //2. Then note the stop for the model, so the next reply does not continue the stopped one.
  async handleStreamCancelled(
    thread: ThreadMetadata,
    pendingItems: ThreadItem[],
    context: TContext,
  ) {
    for (const item of pendingItems) {
      if (
        item.type === 'assistant_message' &&
        item.content.some((part) => part.text.trim())
      )
        await this.store.addThreadItem(thread.id, item, context);
    }
    await this.store.addThreadItem(
      thread.id,
      {
        type: 'sdk_hidden_context',
        id: this.store.generateItemId('sdk_hidden_context', thread, context),
        thread_id: thread.id,
        created_at: new Date().toISOString(),
        content:
          'The user cancelled the stream. Stop responding to the prior request.',
      },
      context,
    );
  }

  //1. Parse one request body and route it. Streaming requests return SSE lines.
  //2. signal is the HTTP connection: aborting it cancels the stream and saves what arrived.
  async process(
    body: string,
    context: TContext,
    signal?: AbortSignal,
  ): Promise<ChatKitResult> {
    const request = parseRequest(body);
    if (isStreamingReq(request))
      return { streaming: true, stream: this.sse(request, context, signal) };
    return {
      streaming: false,
      json: await this.processNonStreaming(request, context),
    };
  }

  private async processNonStreaming(
    request: NonStreamingReq,
    context: TContext,
  ): Promise<string> {
    switch (request.type) {
      case 'threads.get_by_id':
        return serialize(
          toThreadResponse(
            await this.loadFullThread(request.params.thread_id, context),
          ),
        );
      case 'threads.list': {
        const { limit, after, order } = request.params;
        const threads = await this.store.loadThreads(
          limit || DEFAULT_PAGE_SIZE,
          after ?? null,
          order ?? 'desc',
          context,
        );
        return serialize({
          has_more: threads.has_more,
          after: threads.after,
          data: threads.data.map((thread) => toThreadResponse(thread)),
        });
      }
      case 'items.feedback':
        await this.addFeedback(
          request.params.thread_id,
          request.params.item_ids,
          request.params.kind,
          context,
        );
        return '{}';
      case 'attachments.create': {
        const attachment = await this.requireAttachmentStore().createAttachment(
          request.params,
          context,
        );
        await this.store.saveAttachment(attachment, context);
        return serialize(attachment);
      }
      case 'attachments.delete':
        await this.requireAttachmentStore().deleteAttachment(
          request.params.attachment_id,
          context,
        );
        await this.store.deleteAttachment(
          request.params.attachment_id,
          context,
        );
        return '{}';
      case 'input.transcribe':
        return serialize(
          await this.transcribe(
            {
              data: Buffer.from(request.params.audio_base64, 'base64'),
              mime_type: request.params.mime_type,
            },
            context,
          ),
        );
      case 'items.list': {
        const { thread_id, limit, order, after } = request.params;
        const items = await this.store.loadThreadItems(
          thread_id,
          after ?? null,
          limit || DEFAULT_PAGE_SIZE,
          order ?? 'desc',
          context,
        );
        return serialize({
          ...items,
          data: items.data.filter((item) => !isHiddenItem(item)),
        });
      }
      case 'threads.update': {
        const thread = await this.store.loadThread(
          request.params.thread_id,
          context,
        );
        thread.title = request.params.title;
        await this.store.saveThread(thread, context);
        return serialize(toThreadResponse(thread));
      }
      case 'threads.delete':
        await this.store.deleteThread(request.params.thread_id, context);
        return '{}';
      case 'threads.sync_custom_action': {
        const { thread, sender } = await this.loadActionTarget(
          request.params.thread_id,
          request.params.item_id,
          context,
        );
        return serialize(
          await this.syncAction(thread, request.params.action, sender, context),
        );
      }
    }
  }

  private async *sse(
    request: StreamingReq,
    context: TContext,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    for await (const event of this.processStreaming(request, context, signal))
      yield `data: ${serialize(event)}\n\n`;
  }

  private async *processStreaming(
    request: StreamingReq,
    context: TContext,
    signal?: AbortSignal,
  ): AsyncGenerator<ThreadStreamEvent> {
    switch (request.type) {
      case 'threads.create': {
        const thread: ThreadMetadata = {
          id: this.store.generateThreadId(context),
          created_at: new Date().toISOString(),
          status: { type: 'active' },
          metadata: {},
        };
        await this.store.saveThread(thread, context);
        yield { type: 'thread.created', thread: toThreadResponse(thread) };
        const message = await this.buildUserMessage(
          request.params.input,
          thread,
          context,
        );
        yield* this.respondToNewMessage(thread, message, context, signal);
        return;
      }
      case 'threads.add_user_message': {
        const thread = await this.store.loadThread(
          request.params.thread_id,
          context,
        );
        const message = await this.buildUserMessage(
          request.params.input,
          thread,
          context,
        );
        yield* this.respondToNewMessage(thread, message, context, signal);
        return;
      }
      case 'threads.add_client_tool_output': {
        const thread = await this.store.loadThread(
          request.params.thread_id,
          context,
        );
        const latest = await this.store.loadThreadItems(
          thread.id,
          null,
          1,
          'desc',
          context,
        );
        const call = latest.data.find(
          (item) =>
            item.type === 'client_tool_call' && item.status === 'pending',
        );
        if (!call || call.type !== 'client_tool_call')
          throw new InvalidRequestError(
            `The last item in ${thread.id} is not a pending client tool call.`,
          );
        await this.store.saveItem(
          thread.id,
          { ...call, output: request.params.result, status: 'completed' },
          context,
        );
        await this.cleanupPendingClientToolCalls(thread, context);
        yield* this.processEvents(
          thread,
          context,
          () => this.respond(thread, undefined, context),
          signal,
        );
        return;
      }
      case 'threads.add_structured_input': {
        const thread = await this.store.loadThread(
          request.params.thread_id,
          context,
        );
        const item = await this.store.loadItem(
          thread.id,
          request.params.item_id,
          context,
        );
        if (item.type !== 'structured_input')
          throw new InvalidRequestError(
            `Item ${request.params.item_id} is not a structured input.`,
          );
        const answered = this.applyStructuredInput(item, request.params.input);
        const respond = this.respond.bind(this);
        yield* this.processEvents(
          thread,
          context,
          async function* () {
            yield { type: 'thread.item.replaced', item: answered };
            yield* respond(thread, undefined, context);
          },
          signal,
        );
        return;
      }
      case 'threads.retry_after_item': {
        const thread = await this.store.loadThread(
          request.params.thread_id,
          context,
        );
        const removed: ThreadItem[] = [];
        let message: UserMessageItem | undefined;
        for await (const item of this.itemsNewestFirst(thread.id, context)) {
          if (item.id === request.params.item_id) {
            if (item.type !== 'user_message')
              throw new InvalidRequestError(
                `Item ${request.params.item_id} is not a user message.`,
              );
            message = item;
            break;
          }
          removed.push(item);
        }
        if (!message) return;
        for (const item of removed)
          await this.store.deleteThreadItem(thread.id, item.id, context);
        const retried = message;
        yield* this.processEvents(
          thread,
          context,
          () => this.respond(thread, retried, context),
          signal,
        );
        return;
      }
      case 'threads.custom_action': {
        const { thread, sender, invalid } = await this.loadActionTarget(
          request.params.thread_id,
          request.params.item_id,
          context,
          false,
        );
        if (invalid) {
          yield {
            type: 'error',
            code: ErrorCode.STREAM_ERROR,
            allow_retry: false,
          };
          return;
        }
        yield* this.processEvents(
          thread,
          context,
          () => this.action(thread, request.params.action, sender, context),
          signal,
        );
        return;
      }
    }
  }

  private async loadActionTarget(
    threadId: string,
    itemId: string | null | undefined,
    context: TContext,
    throwOnInvalid = true,
  ) {
    const thread = await this.store.loadThread(threadId, context);
    const item = itemId
      ? await this.store.loadItem(threadId, itemId, context)
      : undefined;
    if (item && item.type !== 'widget') {
      if (throwOnInvalid)
        throw new InvalidRequestError(
          'An action sender must be a widget item.',
        );
      return { thread, sender: undefined, invalid: true };
    }
    return { thread, sender: item, invalid: false };
  }

  private applyStructuredInput(
    item: StructuredInputItem,
    submission: StructuredInputSubmission,
  ): StructuredInputItem {
    if (item.status !== 'pending')
      throw new InvalidRequestError(
        `Structured input ${item.id} is not pending.`,
      );
    const status = submission.status ?? 'answered';
    const answers = submission.answers ?? {};
    const unknown = Object.keys(answers).filter(
      (id) => !item.inputs.some((input) => input.id === id),
    );
    if (unknown.length)
      this.logger.warn(
        `Structured input ${item.id} ignored unknown answers: ${unknown.sort().join(', ')}`,
      );
    return {
      ...item,
      status,
      inputs: item.inputs.map((input) => {
        const answer = answers[input.id];
        if (
          status === 'skipped' ||
          !answer ||
          answer.skipped ||
          !answer.values?.length
        )
          return { ...input, answer: { values: [], skipped: true } };
        const values =
          input.type === 'multiple_choice' && !input.multiple
            ? answer.values.slice(0, 1)
            : answer.values;
        return { ...input, answer: { values, skipped: false } };
      }),
    };
  }

  private async cleanupPendingClientToolCalls(
    thread: ThreadMetadata,
    context: TContext,
  ) {
    const items = await this.store.loadThreadItems(
      thread.id,
      null,
      DEFAULT_PAGE_SIZE,
      'desc',
      context,
    );
    for (const item of items.data) {
      if (item.type === 'client_tool_call' && item.status === 'pending') {
        this.logger.warn(`Client tool call ${item.call_id} was not completed.`);
        await this.store.deleteThreadItem(thread.id, item.id, context);
      }
    }
  }

  private async *respondToNewMessage(
    thread: ThreadMetadata,
    message: UserMessageItem,
    context: TContext,
    signal?: AbortSignal,
  ): AsyncGenerator<ThreadStreamEvent> {
    // Attachments now belong to this thread.
    for (const attachment of message.attachments)
      await this.store.saveAttachment(attachment, context);
    await this.store.addThreadItem(thread.id, message, context);
    yield { type: 'thread.item.done', item: message };
    yield* this.processEvents(
      thread,
      context,
      () => this.respond(thread, message, context),
      signal,
    );
  }

  //1. Persist each item as it finishes, and tell the client about every event except hidden context.
  //2. A thread changed during the stream (for example its title) is saved and sent as thread.updated.
  //3. Errors become error events, so the client can show them and offer a retry.
  private async *processEvents(
    thread: ThreadMetadata,
    context: TContext,
    stream: () => AsyncIterable<ThreadStreamEvent>,
    signal?: AbortSignal,
  ): AsyncGenerator<ThreadStreamEvent> {
    yield {
      type: 'stream_options',
      stream_options: this.getStreamOptions(thread, context),
    };
    let saved = JSON.stringify(thread);
    const pending = new Map<string, ThreadItem>();
    const threadChanged = async () => {
      const now = JSON.stringify(thread);
      if (now === saved) return false;
      saved = now;
      await this.store.saveThread(thread, context);
      return true;
    };
    try {
      for await (const event of stream()) {
        signal?.throwIfAborted();
        switch (event.type) {
          case 'thread.item.added':
            pending.set(event.item.id, structuredClone(event.item));
            break;
          case 'thread.item.done':
            await this.store.addThreadItem(thread.id, event.item, context);
            pending.delete(event.item.id);
            break;
          case 'thread.item.removed':
            await this.store.deleteThreadItem(
              thread.id,
              event.item_id,
              context,
            );
            pending.delete(event.item_id);
            break;
          case 'thread.item.replaced':
            await this.store.saveItem(thread.id, event.item, context);
            pending.delete(event.item.id);
            break;
          case 'thread.item.updated':
            applyPendingUpdate(pending, event.item_id, event.update);
            break;
        }
        if (!(event.type === 'thread.item.done' && isHiddenItem(event.item)))
          yield event;
        if (await threadChanged())
          yield { type: 'thread.updated', thread: toThreadResponse(thread) };
      }
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) {
        await this.handleStreamCancelled(
          thread,
          [...pending.values()],
          context,
        );
        return;
      }
      if (error instanceof CustomStreamError) {
        yield {
          type: 'error',
          code: 'custom',
          message: error.message,
          allow_retry: error.allowRetry,
        };
      } else if (error instanceof StreamError) {
        yield {
          type: 'error',
          code: error.code,
          allow_retry: error.allowRetry,
        };
      } else {
        this.logger.error({
          message: 'A ChatKit response failed.',
          error: error instanceof Error ? error.name : 'Error',
        });
        yield {
          type: 'error',
          code: ErrorCode.STREAM_ERROR,
          allow_retry: true,
        };
      }
    }
    if (await threadChanged())
      yield { type: 'thread.updated', thread: toThreadResponse(thread) };
  }

  private async buildUserMessage(
    input: UserMessageInput,
    thread: ThreadMetadata,
    context: TContext,
  ): Promise<UserMessageItem> {
    const attachments = [];
    for (const id of input.attachments ?? []) {
      const attachment = await this.store.loadAttachment(id, context);
      attachments.push({ ...attachment, thread_id: thread.id });
    }
    return {
      type: 'user_message',
      id: this.store.generateItemId('message', thread, context),
      thread_id: thread.id,
      created_at: new Date().toISOString(),
      content: input.content,
      attachments,
      ...(input.quoted_text != null && { quoted_text: input.quoted_text }),
      inference_options: input.inference_options ?? {},
    };
  }

  private async loadFullThread(
    threadId: string,
    context: TContext,
  ): Promise<Thread> {
    const metadata = await this.store.loadThread(threadId, context);
    const items = await this.store.loadThreadItems(
      threadId,
      null,
      DEFAULT_PAGE_SIZE,
      'asc',
      context,
    );
    return { ...metadata, items };
  }

  private async *itemsNewestFirst(threadId: string, context: TContext) {
    let after: string | null = null;
    for (;;) {
      const page: Page<ThreadItem> = await this.store.loadThreadItems(
        threadId,
        after,
        DEFAULT_PAGE_SIZE,
        'desc',
        context,
      );
      yield* page.data;
      if (!page.has_more) return;
      after = page.after ?? null;
    }
  }

  private requireAttachmentStore() {
    if (!this.attachmentStore)
      throw new Error('Attachments are off: no AttachmentStore was given.');
    return this.attachmentStore;
  }
}

// Validates the shape enough to route safely. Each handler reads only the fields it needs.
export function parseRequest(body: string): ChatKitReq {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidRequestError('The ChatKit request is not valid JSON.');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== 'string' ||
    !REQUEST_TYPES.has((parsed as { type: string }).type) ||
    typeof (parsed as { params?: unknown }).params !== 'object' ||
    (parsed as { params?: unknown }).params === null
  )
    throw new InvalidRequestError();
  return parsed as ChatKitReq;
}

// Server-side thread metadata and hidden items never reach the client.
export function toThreadResponse(thread: ThreadMetadata | Thread): Thread {
  const items: Page<ThreadItem> =
    'items' in thread
      ? {
          ...thread.items,
          data: thread.items.data.filter((item) => !isHiddenItem(item)),
        }
      : { data: [], has_more: false };
  return {
    id: thread.id,
    ...(thread.title != null && { title: thread.title }),
    created_at: thread.created_at,
    status: thread.status,
    ...(thread.allowed_image_domains != null && {
      allowed_image_domains: thread.allowed_image_domains,
    }),
    items,
  };
}

// Like the Python SDK: drop nulls, and never send attachment metadata to the client.
export function serialize(value: unknown): string {
  return JSON.stringify(value, (key, entry: unknown) => {
    if (entry === null || entry === undefined) return undefined;
    if (key === 'attachments' && Array.isArray(entry))
      return entry.map((attachment) => withoutMetadata(attachment));
    if (isAttachment(entry)) return withoutMetadata(entry);
    return entry;
  });
}

function isAttachment(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'mime_type' in value &&
    'id' in value &&
    ((value as { type?: unknown }).type === 'file' ||
      (value as { type?: unknown }).type === 'image')
  );
}

function withoutMetadata(value: unknown) {
  if (!isAttachment(value)) return value;
  const { metadata: _metadata, ...rest } = value;
  return rest;
}

// Keeps a copy of streamed assistant text and workflow tasks, so a cancel can save them.
function applyPendingUpdate(
  pending: Map<string, ThreadItem>,
  itemId: string,
  update: ThreadItemUpdate,
) {
  const item = pending.get(itemId);
  if (!item) return;
  if (
    item.type === 'assistant_message' &&
    update.type.startsWith('assistant_message.')
  ) {
    pending.set(itemId, applyAssistantUpdate(item, update));
  } else if (item.type === 'workflow') {
    if (update.type === 'workflow.task.updated')
      item.workflow.tasks[update.task_index] = update.task;
    else if (update.type === 'workflow.task.added')
      item.workflow.tasks.push(update.task);
  }
}

function applyAssistantUpdate(
  item: AssistantMessageItem,
  update: ThreadItemUpdate,
): AssistantMessageItem {
  if (!('content_index' in update)) return item;
  const content: AssistantMessageContent[] = item.content.map((part) => ({
    ...part,
    annotations: [...part.annotations],
  }));
  while (content.length <= update.content_index)
    content.push({ type: 'output_text', text: '', annotations: [] });
  const part = content[update.content_index];
  switch (update.type) {
    case 'assistant_message.content_part.added':
    case 'assistant_message.content_part.done':
      content[update.content_index] = update.content;
      break;
    case 'assistant_message.content_part.text_delta':
      part.text += update.delta;
      break;
    case 'assistant_message.content_part.annotation_added':
      if (update.annotation_index <= part.annotations.length)
        part.annotations.splice(update.annotation_index, 0, update.annotation);
      else part.annotations.push(update.annotation);
      break;
  }
  return { ...item, content };
}

// What a client tool asks the browser to run. The run stops so the browser can answer.
export type ClientToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

// A simple async queue: tools push events while the model streams.
class EventQueue {
  private readonly items: ThreadStreamEvent[] = [];
  private waiter?: () => void;
  private closed = false;

  push(event: ThreadStreamEvent) {
    if (this.closed) return;
    this.items.push(event);
    this.waiter?.();
  }

  close() {
    this.closed = true;
    this.waiter?.();
  }

  drain() {
    return this.items.splice(0);
  }

  next(): Promise<void> {
    if (this.items.length || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiter = () => {
        this.waiter = undefined;
        resolve();
      };
    });
  }
}

//1. The run context ChatKit tools receive as runContext.context.
//2. Tools stream widgets, progress, and workflow tasks through it, and request client tools.
export class AgentContext<TContext = unknown> {
  readonly thread: ThreadMetadata;
  readonly store: Store<TContext>;
  readonly requestContext: TContext;
  previousResponseId?: string;
  clientToolCall?: ClientToolCall;
  workflowItem?: WorkflowItem;
  generatedImageItem?: GeneratedImageItem;
  readonly events = new EventQueue();

  constructor(options: {
    thread: ThreadMetadata;
    store: Store<TContext>;
    requestContext: TContext;
    previousResponseId?: string;
  }) {
    this.thread = options.thread;
    this.store = options.store;
    this.requestContext = options.requestContext;
    this.previousResponseId = options.previousResponseId;
  }

  generateId(type: StoreItemType, thread?: ThreadMetadata) {
    if (type === 'thread')
      return this.store.generateThreadId(this.requestContext);
    return this.store.generateItemId(
      type,
      thread ?? this.thread,
      this.requestContext,
    );
  }

  // Shows a widget now, or streams a changing widget.
  async streamWidget(
    widget: WidgetRoot | AsyncIterable<WidgetRoot>,
    copyText?: string,
  ) {
    for await (const event of streamWidget(
      this.thread,
      widget,
      copyText,
      (type) => this.generateId(type),
    ))
      this.stream(event);
  }

  // A short status line while a long tool works. ChatKit replaces it with the next item.
  streamProgress(text: string, icon?: IconName) {
    this.stream({ type: 'progress_update', text, ...(icon && { icon }) });
  }

  startWorkflow(workflow: Workflow) {
    this.workflowItem = {
      type: 'workflow',
      id: this.generateId('workflow'),
      thread_id: this.thread.id,
      created_at: new Date().toISOString(),
      workflow,
    };
    // A custom workflow without tasks is sent once its first task arrives.
    if (workflow.type !== 'reasoning' && workflow.tasks.length === 0) return;
    this.stream({ type: 'thread.item.added', item: this.workflowItem });
  }

  addWorkflowTask(task: Task) {
    this.workflowItem ??= {
      type: 'workflow',
      id: this.generateId('workflow'),
      thread_id: this.thread.id,
      created_at: new Date().toISOString(),
      workflow: { type: 'custom', tasks: [] },
    };
    const { workflow } = this.workflowItem;
    workflow.tasks.push(task);
    if (workflow.type !== 'reasoning' && workflow.tasks.length === 1)
      this.stream({ type: 'thread.item.added', item: this.workflowItem });
    else
      this.stream({
        type: 'thread.item.updated',
        item_id: this.workflowItem.id,
        update: {
          type: 'workflow.task.added',
          task,
          task_index: workflow.tasks.length - 1,
        },
      });
  }

  updateWorkflowTask(task: Task, taskIndex: number) {
    if (!this.workflowItem) throw new Error('No workflow is running.');
    this.workflowItem.workflow.tasks[taskIndex] = task;
    this.stream({
      type: 'thread.item.updated',
      item_id: this.workflowItem.id,
      update: { type: 'workflow.task.updated', task, task_index: taskIndex },
    });
  }

  endWorkflow(summary?: WorkflowSummary, expanded = false) {
    if (!this.workflowItem) return;
    const { workflow } = this.workflowItem;
    if (summary) workflow.summary = summary;
    else
      workflow.summary ??= {
        duration: secondsSince(this.workflowItem.created_at),
      };
    workflow.expanded = expanded;
    this.stream({ type: 'thread.item.done', item: this.workflowItem });
    this.workflowItem = undefined;
  }

  stream(event: ThreadStreamEvent) {
    this.events.push(event);
  }

  // A paused run saves its context as JSON. Keep only the thread id: the store and the
  // event queue must never be written. Attach a fresh AgentContext when it resumes.
  toJSON() {
    return { thread_id: this.thread.id };
  }
}

//1. A tool the browser runs, such as reading the page. Give it to the agent and pass
//   clientToolStopBehavior so the run stops at it and the browser can answer.
//2. The browser's answer comes back as threads.add_client_tool_output, then respond runs again.
export function clientTool(options: {
  name: string;
  description: string;
  // A JSON schema object, such as { type: 'object', properties: {}, required: [] }.
  parameters: Record<string, unknown>;
}): Tool {
  return tool({
    name: options.name,
    description: options.description,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: true,
      ...options.parameters,
    } as never,
    strict: false,
    execute: (input, runContext?: RunContext<unknown>) => {
      const context = runContext?.context;
      if (!(context instanceof AgentContext))
        throw new Error('Client tools need an AgentContext run context.');
      context.clientToolCall = {
        name: options.name,
        arguments: (input ?? {}) as Record<string, unknown>,
      };
      return 'Sent to the browser.';
    },
  });
}

// Pass as the agent's toolUseBehavior, so the run stops after a client tool.
export function clientToolStopBehavior(names: string[]) {
  return { stopAtToolNames: names };
}

// Optional hooks for things the default conversion cannot know, such as hosting images.
export class ResponseStreamConverter {
  constructor(readonly partialImages?: number) {}

  base64ImageToUrl(
    _imageId: string,
    base64Image: string,
    _partialImageIndex?: number,
  ): Promise<string> {
    return Promise.resolve(`data:image/png;base64,${base64Image}`);
  }

  partialImageIndexToProgress(partialImageIndex: number) {
    if (!this.partialImages || this.partialImages <= 0) return 0;
    return Math.min(1, partialImageIndex / this.partialImages);
  }

  annotation(raw: Record<string, unknown>): Annotation | undefined {
    if (
      raw.type === 'file_citation' &&
      typeof raw.filename === 'string' &&
      raw.filename
    )
      return {
        type: 'annotation',
        source: { type: 'file', filename: raw.filename, title: raw.filename },
        index: numberOrNull(raw.index),
      };
    if (
      raw.type === 'container_file_citation' &&
      typeof raw.filename === 'string' &&
      raw.filename
    )
      return {
        type: 'annotation',
        source: { type: 'file', filename: raw.filename, title: raw.filename },
        index: numberOrNull(raw.end_index),
      };
    if (raw.type === 'url_citation' && typeof raw.url === 'string')
      return {
        type: 'annotation',
        source: {
          type: 'url',
          url: raw.url,
          title: typeof raw.title === 'string' ? raw.title : raw.url,
        },
        index: numberOrNull(raw.end_index),
      };
    return undefined;
  }
}

type RawEvent = Record<string, unknown> & { type: string };

//1. Turns a streamed Agents SDK run into ChatKit events, like the Python stream_agent_response.
//2. Assistant text streams as content parts. Reasoning shows as a workflow of thoughts.
//3. A guardrail stop removes everything this run produced, then the error goes on.
export async function* streamAgentResponse<TContext>(
  context: AgentContext<TContext>,
  // A streamed run result, or any iterable of the same events.
  result: AsyncIterable<RunStreamEvent>,
  converter = new ResponseStreamConverter(),
): AsyncGenerator<ThreadStreamEvent> {
  const thread = context.thread;
  const produced = new Set<string>();
  const annotationCounts = new Map<string, number>();
  let streamingThought:
    { itemId: string; index: number; task: ThoughtTask } | undefined;
  let currentToolCall: string | undefined;
  let currentItemId: string | undefined;

  // Continue a workflow left open by the last turn, or the one before a client tool call.
  const recent = await context.store.loadThreadItems(
    thread.id,
    null,
    2,
    'desc',
    context.requestContext,
  );
  const [last, previous] = recent.data;
  if (last?.type === 'workflow') context.workflowItem = last;
  else if (last?.type === 'client_tool_call' && previous?.type === 'workflow')
    context.workflowItem = previous;

  const endWorkflow = (item: WorkflowItem): ThreadStreamEvent => {
    if (item === context.workflowItem) context.workflowItem = undefined;
    item.workflow.summary ??= { duration: secondsSince(item.created_at) };
    item.workflow.expanded = false;
    return { type: 'thread.item.done', item };
  };

  const fromContext = function* (): Generator<ThreadStreamEvent> {
    for (const event of context.events.drain()) {
      if (
        event.type === 'thread.item.added' ||
        event.type === 'thread.item.done'
      ) {
        if (
          context.workflowItem &&
          context.workflowItem.id !== event.item.id &&
          event.item.type !== 'client_tool_call' &&
          event.item.type !== 'hidden_context_item'
        )
          yield endWorkflow(context.workflowItem);
        if (
          event.type === 'thread.item.added' &&
          event.item.type === 'workflow'
        )
          context.workflowItem = event.item;
        produced.add(event.item.id);
      }
      yield event;
    }
  };

  const iterator = result[Symbol.asyncIterator]();
  let nextEvent = iterator.next();
  try {
    for (;;) {
      // Tool events and model events interleave in the order they happen.
      const winner = await Promise.race([
        nextEvent.then((step) => ({ kind: 'run' as const, step })),
        context.events.next().then(() => ({ kind: 'context' as const })),
      ]);
      yield* fromContext();
      if (winner.kind === 'context') continue;
      const { step } = winner;
      if (step.done) break;
      nextEvent = iterator.next();
      const event = step.value;

      if (event.type === 'run_item_stream_event') {
        if (event.item.type === 'tool_call_item') {
          const raw = event.item.rawItem as {
            type?: string;
            callId?: string;
            id?: string;
          };
          if (raw.type === 'function_call' && raw.callId) {
            currentToolCall = raw.callId;
            currentItemId = raw.id;
            if (raw.id) produced.add(raw.id);
          }
        }
        continue;
      }
      if (
        event.type !== 'raw_model_stream_event' ||
        event.data.type !== 'model'
      )
        continue;
      const raw = (event.data as { event?: RawEvent }).event;
      if (!raw || typeof raw.type !== 'string') continue;
      yield* convertRaw(raw);
    }
  } catch (error) {
    if (
      error instanceof InputGuardrailTripwireTriggered ||
      error instanceof OutputGuardrailTripwireTriggered
    ) {
      for (const itemId of produced)
        yield { type: 'thread.item.removed', item_id: itemId };
      context.events.close();
      context.events.drain();
    }
    throw error;
  }
  context.events.close();
  yield* fromContext();

  // An open workflow is saved, so the next turn can continue it.
  if (context.workflowItem)
    await context.store.addThreadItem(
      thread.id,
      context.workflowItem,
      context.requestContext,
    );

  if (context.clientToolCall) {
    const item: ClientToolCallItem = {
      type: 'client_tool_call',
      id: currentItemId ?? context.generateId('tool_call'),
      thread_id: thread.id,
      created_at: new Date().toISOString(),
      status: 'pending',
      call_id: currentToolCall ?? context.generateId('tool_call'),
      name: context.clientToolCall.name,
      arguments: context.clientToolCall.arguments,
    };
    yield { type: 'thread.item.done', item };
  }

  async function* convertRaw(raw: RawEvent): AsyncGenerator<ThreadStreamEvent> {
    const itemId = String(raw.item_id ?? '');
    const contentIndex = Number(raw.content_index ?? 0);
    switch (raw.type) {
      case 'response.content_part.added': {
        const part = raw.part as Record<string, unknown>;
        if (part.type === 'reasoning_text') return;
        yield {
          type: 'thread.item.updated',
          item_id: itemId,
          update: {
            type: 'assistant_message.content_part.added',
            content_index: contentIndex,
            content: convertContent(part),
          },
        };
        return;
      }
      case 'response.output_text.delta':
        yield {
          type: 'thread.item.updated',
          item_id: itemId,
          update: {
            type: 'assistant_message.content_part.text_delta',
            content_index: contentIndex,
            delta: String(raw.delta ?? ''),
          },
        };
        return;
      case 'response.output_text.done':
        yield {
          type: 'thread.item.updated',
          item_id: itemId,
          update: {
            type: 'assistant_message.content_part.done',
            content_index: contentIndex,
            content: {
              type: 'output_text',
              text: String(raw.text ?? ''),
              annotations: [],
            },
          },
        };
        return;
      case 'response.output_text.annotation.added': {
        const annotation = converter.annotation(
          (raw.annotation ?? {}) as Record<string, unknown>,
        );
        if (!annotation) return;
        // Count per content part, in case an annotation could not be converted.
        const key = `${itemId}:${contentIndex}`;
        const index = annotationCounts.get(key) ?? 0;
        annotationCounts.set(key, index + 1);
        yield {
          type: 'thread.item.updated',
          item_id: itemId,
          update: {
            type: 'assistant_message.content_part.annotation_added',
            content_index: contentIndex,
            annotation_index: index,
            annotation,
          },
        };
        return;
      }
      case 'response.output_item.added': {
        const item = raw.item as Record<string, unknown>;
        if (item.type === 'reasoning' && !context.workflowItem) {
          context.workflowItem = {
            type: 'workflow',
            id: context.generateId('workflow'),
            thread_id: thread.id,
            created_at: new Date().toISOString(),
            workflow: { type: 'reasoning', tasks: [] },
          };
          produced.add(context.workflowItem.id);
          yield { type: 'thread.item.added', item: context.workflowItem };
        }
        if (item.type === 'message') {
          if (context.workflowItem) yield endWorkflow(context.workflowItem);
          const id = String(item.id);
          produced.add(id);
          yield {
            type: 'thread.item.added',
            item: {
              type: 'assistant_message',
              id,
              thread_id: thread.id,
              created_at: new Date().toISOString(),
              content: contentList(item.content),
            },
          };
        } else if (item.type === 'image_generation_call') {
          context.generatedImageItem = {
            type: 'generated_image',
            id: context.generateId('message'),
            thread_id: thread.id,
            created_at: new Date().toISOString(),
          };
          produced.add(context.generatedImageItem.id);
          yield { type: 'thread.item.added', item: context.generatedImageItem };
        }
        return;
      }
      case 'response.image_generation_call.partial_image': {
        const imageItem = context.generatedImageItem;
        if (!imageItem) return;
        const partialIndex = Number(raw.partial_image_index ?? 0);
        const url = await converter.base64ImageToUrl(
          itemId,
          String(raw.partial_image_b64 ?? ''),
          partialIndex,
        );
        imageItem.image = { id: itemId, url };
        yield {
          type: 'thread.item.updated',
          item_id: imageItem.id,
          update: {
            type: 'generated_image.updated',
            image: imageItem.image,
            progress: converter.partialImageIndexToProgress(partialIndex),
          },
        };
        return;
      }
      case 'response.reasoning_summary_text.delta': {
        const workflow = context.workflowItem;
        if (!workflow) return;
        const summaryIndex = Number(raw.summary_index ?? 0);
        const delta = String(raw.delta ?? '');
        if (
          workflow.workflow.type === 'reasoning' &&
          workflow.workflow.tasks.length === 0
        ) {
          // Show the first thought early.
          streamingThought = {
            itemId,
            index: summaryIndex,
            task: { type: 'thought', content: delta },
          };
          workflow.workflow.tasks.push(streamingThought.task);
          yield {
            type: 'thread.item.updated',
            item_id: workflow.id,
            update: {
              type: 'workflow.task.added',
              task: streamingThought.task,
              task_index: 0,
            },
          };
        } else if (
          streamingThought &&
          workflow.workflow.tasks.includes(streamingThought.task) &&
          streamingThought.itemId === itemId &&
          streamingThought.index === summaryIndex
        ) {
          streamingThought.task.content += delta;
          yield {
            type: 'thread.item.updated',
            item_id: workflow.id,
            update: {
              type: 'workflow.task.updated',
              task: streamingThought.task,
              task_index: workflow.workflow.tasks.indexOf(
                streamingThought.task,
              ),
            },
          };
        }
        return;
      }
      case 'response.reasoning_summary_text.done': {
        const workflow = context.workflowItem;
        if (!workflow) return;
        const summaryIndex = Number(raw.summary_index ?? 0);
        const text = String(raw.text ?? '');
        if (
          streamingThought &&
          workflow.workflow.tasks.includes(streamingThought.task) &&
          streamingThought.itemId === itemId &&
          streamingThought.index === summaryIndex
        ) {
          const task = streamingThought.task;
          task.content = text;
          streamingThought = undefined;
          yield {
            type: 'thread.item.updated',
            item_id: workflow.id,
            update: {
              type: 'workflow.task.updated',
              task,
              task_index: workflow.workflow.tasks.indexOf(task),
            },
          };
        } else {
          const task: ThoughtTask = { type: 'thought', content: text };
          workflow.workflow.tasks.push(task);
          yield {
            type: 'thread.item.updated',
            item_id: workflow.id,
            update: {
              type: 'workflow.task.added',
              task,
              task_index: workflow.workflow.tasks.length - 1,
            },
          };
        }
        return;
      }
      case 'response.output_item.done': {
        const item = raw.item as Record<string, unknown>;
        if (item.type === 'message') {
          const id = String(item.id);
          produced.add(id);
          yield {
            type: 'thread.item.done',
            item: {
              type: 'assistant_message',
              id,
              thread_id: thread.id,
              created_at: new Date().toISOString(),
              content: contentList(item.content),
            },
          };
        } else if (item.type === 'image_generation_call' && item.result) {
          const imageItem = context.generatedImageItem;
          if (!imageItem) return;
          const url = await converter.base64ImageToUrl(
            String(item.id),
            String(item.result),
          );
          imageItem.image = { id: String(item.id), url };
          yield { type: 'thread.item.done', item: imageItem };
          context.generatedImageItem = undefined;
        }
        return;
      }
    }
  }

  function contentList(content: unknown): AssistantMessageContent[] {
    return Array.isArray(content)
      ? content.map((part) => convertContent(part as Record<string, unknown>))
      : [];
  }

  function convertContent(
    part: Record<string, unknown>,
  ): AssistantMessageContent {
    if (part.type === 'output_text')
      return {
        type: 'output_text',
        text: String(part.text ?? ''),
        annotations: (Array.isArray(part.annotations) ? part.annotations : [])
          .map((annotation) =>
            converter.annotation(annotation as Record<string, unknown>),
          )
          .filter((annotation): annotation is Annotation => !!annotation),
      };
    return {
      type: 'output_text',
      text: String(part.refusal ?? ''),
      annotations: [],
    };
  }
}

const userText = (text: string): AgentInputItem => ({
  role: 'user',
  content: [{ type: 'input_text', text }],
});

const taskText = (title?: string | null, content?: string | null) =>
  title && content ? `${title}: ${content}` : title || content || '';

//1. Turns saved thread items into model input, like the Python ThreadItemConverter.
//2. Override attachmentToMessageContent when attachments are on, and tagToMessageContent for @-mentions.
export class ThreadItemConverter {
  attachmentToMessageContent(_attachment: Attachment): Promise<unknown> {
    return Promise.reject(
      new Error(
        'A message had an attachment, but attachmentToMessageContent is not implemented.',
      ),
    );
  }

  // Tags carry entity data. The default shows the model the tag's text and data.
  tagToMessageContent(tag: UserMessageTagContent): Promise<unknown> {
    return Promise.resolve({
      type: 'input_text',
      text: `@${tag.text}: ${JSON.stringify(tag.data)}`,
    });
  }

  generatedImageToInput(item: GeneratedImageItem): AgentInputItem[] {
    if (!item.image) return [];
    return [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'The following image was generated by the agent.',
          },
          { type: 'input_image', image: item.image.url, detail: 'auto' },
        ],
      },
    ];
  }

  hiddenContextToInput(item: HiddenContextItem): AgentInputItem[] {
    if (typeof item.content !== 'string')
      throw new Error(
        'Hidden context with non-text content needs hiddenContextToInput to be overridden.',
      );
    return [hidden(item.content)];
  }

  sdkHiddenContextToInput(item: SDKHiddenContextItem): AgentInputItem[] {
    return [hidden(item.content)];
  }

  taskToInput(item: TaskItem): AgentInputItem[] {
    const { task } = item;
    if (task.type !== 'custom' || (!task.title && !task.content)) return [];
    return [performed(taskText(task.title, task.content))];
  }

  structuredInputToInput(item: StructuredInputItem): AgentInputItem[] {
    const lines = item.inputs.map((input) => {
      const answer = input.answer;
      if (!answer) return `- ${input.question}: unanswered`;
      if (answer.skipped) return `- ${input.question}: skipped`;
      return `- ${input.question}: ${answer.values.join(', ')}`;
    });
    return [
      userText(
        `A structured input request was displayed to the user with the following status: ${item.status}\n<StructuredInput>\n${lines.join('\n')}\n</StructuredInput>`,
      ),
    ];
  }

  workflowToInput(item: WorkflowItem): AgentInputItem[] {
    return item.workflow.tasks
      .filter((task) => task.type === 'custom' && (task.title || task.content))
      .map((task) => {
        const custom = task as Extract<Task, { type: 'custom' }>;
        return performed(taskText(custom.title, custom.content));
      });
  }

  widgetToInput(item: WidgetItem): AgentInputItem[] {
    return [
      userText(
        `The following graphical UI widget (id: ${item.id}) was displayed to the user:${JSON.stringify(item.widget)}`,
      ),
    ];
  }

  async userMessageToInput(
    item: UserMessageItem,
    isLastMessage = true,
  ): Promise<AgentInputItem[]> {
    const text = item.content
      .map((part) => (part.type === 'input_text' ? part.text : `@${part.text}`))
      .join('');
    const attachments = [];
    for (const attachment of item.attachments)
      attachments.push(await this.attachmentToMessageContent(attachment));
    const message = {
      role: 'user',
      content: [{ type: 'input_text', text }, ...attachments],
    } as AgentInputItem;
    const context: AgentInputItem[] = [];
    if (item.quoted_text && isLastMessage)
      context.push(
        userText(
          `The user is referring to this in particular: \n${item.quoted_text}`,
        ),
      );
    const tags = item.content.filter(
      (part): part is UserMessageTagContent => part.type === 'input_tag',
    );
    const unique = tags.filter(
      (tag, index) =>
        tags.findIndex((other) => other.text === tag.text) === index,
    );
    if (unique.length) {
      const tagContent = [];
      for (const tag of unique)
        tagContent.push(await this.tagToMessageContent(tag));
      context.push({
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: "# User-provided context for @-mentions\n- When referencing resolved entities, use their canonical names **without** '@'.\n- The '@' form appears only in user text and should not be echoed.",
          },
          ...tagContent,
        ],
      } as AgentInputItem);
    }
    return [message, ...context];
  }

  assistantMessageToInput(item: {
    content: AssistantMessageContent[];
  }): AgentInputItem[] {
    return [
      {
        role: 'assistant',
        status: 'completed',
        content: item.content.map((part) => ({
          type: 'output_text' as const,
          text: part.text,
        })),
      },
    ];
  }

  // A pending call has no output yet, so it cannot go to the model.
  clientToolCallToInput(item: ClientToolCallItem): AgentInputItem[] {
    if (item.status === 'pending') return [];
    return [
      {
        type: 'function_call',
        callId: item.call_id,
        name: item.name,
        arguments: JSON.stringify(item.arguments),
        status: 'completed',
      },
      {
        type: 'function_call_result',
        callId: item.call_id,
        name: item.name,
        status: 'completed',
        output: { type: 'text', text: JSON.stringify(item.output ?? null) },
      },
    ];
  }

  endOfTurnToInput(_item: EndOfTurnItem): AgentInputItem[] {
    return [];
  }

  async toAgentInput(
    items: ThreadItem[] | ThreadItem,
  ): Promise<AgentInputItem[]> {
    const list = Array.isArray(items) ? [...items] : [items];
    const output: AgentInputItem[] = [];
    for (const [index, item] of list.entries())
      output.push(...(await this.itemToInput(item, index === list.length - 1)));
    return output;
  }

  private async itemToInput(
    item: ThreadItem,
    isLast: boolean,
  ): Promise<AgentInputItem[]> {
    switch (item.type) {
      case 'user_message':
        return await this.userMessageToInput(item, isLast);
      case 'assistant_message':
        return this.assistantMessageToInput(item);
      case 'client_tool_call':
        return this.clientToolCallToInput(item);
      case 'end_of_turn':
        return this.endOfTurnToInput(item);
      case 'widget':
        return this.widgetToInput(item);
      case 'workflow':
        return this.workflowToInput(item);
      case 'task':
        return this.taskToInput(item);
      case 'structured_input':
        return this.structuredInputToInput(item);
      case 'hidden_context_item':
        return this.hiddenContextToInput(item);
      case 'sdk_hidden_context':
        return this.sdkHiddenContextToInput(item);
      case 'generated_image':
        return this.generatedImageToInput(item);
    }
  }
}

// The default converter, for apps without attachments.
export function simpleToAgentInput(items: ThreadItem[] | ThreadItem) {
  return new ThreadItemConverter().toAgentInput(items);
}

function hidden(content: string): AgentInputItem {
  return userText(
    `Hidden context for the agent (not shown to the user):\n<HiddenContext>\n${content}\n</HiddenContext>`,
  );
}

function performed(text: string): AgentInputItem {
  return userText(
    `A message was displayed to the user that the following task was performed:\n<Task>\n${text}\n</Task>`,
  );
}

function secondsSince(isoTime: string) {
  return Math.max(0, Math.floor((Date.now() - Date.parse(isoTime)) / 1000));
}

function numberOrNull(value: unknown) {
  return typeof value === 'number' ? value : null;
}
