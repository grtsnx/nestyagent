import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RunState, type Agent, type StreamedRunResult } from '@openai/agents';
import { toFile } from 'openai';
import { z } from 'zod';
import {
  actionConfig,
  CHAT_PAUSED,
  AgentContext,
  ChatKitService,
  CustomStreamError,
  InvalidRequestError,
  NotFoundError,
  requireRecoveryNote,
  streamAgentResponse,
  ThreadItemConverter,
  type Action,
  type Attachment,
  type AudioInput,
  type FeedbackKind,
  type ThreadMetadata,
  type ThreadStreamEvent,
  type TranscriptionResult,
  type UserMessageItem,
  type WidgetItem,
  type WidgetRoot,
} from '@/lib/chatkit/chatkit.service.js';
import {
  AgentVersionMismatchError,
  OpenaiService,
  type RunAgentOptions,
} from '@/lib/openai/openai.service.js';
import { PrismaService } from '@/lib/prisma/prisma.service.js';
import { SystemPromptsService } from '@/modules/system-prompts/system-prompts.service.js';
import {
  ChatKitAttachmentStore,
  ChatKitStore,
  type ChatKitContext,
} from '@/config/chatkit/index.js';

// How many recent items the model sees each turn.
const HISTORY_ITEMS = 50;
const TITLE_LENGTH = 60;
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
//1. Bump when the helper's tools or other execution policy changes.
//2. Editing the system prompt does not change it, so waiting approvals stay answerable.
const AGENT_VERSION = 'mssuzie-chatkit-v1';
const APPROVED = 'Approved.';
const DECLINED = 'Declined.';
const EXPIRED = 'This request expired after an update. Please ask again.';

// The approval buttons send these. The client is untrusted, so the shape is checked.
const approvalAction = z.object({
  type: z.enum(['approval.approve', 'approval.reject']),
  payload: z.object({
    runId: z.uuid(),
    version: z.number().int().nonnegative(),
  }),
});

//1. Sends images and files to the model with their bytes, read from the user's own store.
//2. Images go as data URLs; other files as base64 data with their name.
class AttachmentConverter extends ThreadItemConverter {
  constructor(
    private readonly store: ChatKitStore,
    private readonly userId: string,
  ) {
    super();
  }

  async attachmentToMessageContent(attachment: Attachment) {
    const { content } = await this.store.loadAttachmentContent(
      attachment.id,
      this.userId,
    );
    if (!content)
      return {
        type: 'input_text',
        text: `(The file ${attachment.name} was not uploaded.)`,
      };
    const dataUrl = `data:${attachment.mime_type};base64,${content.toString('base64')}`;
    return attachment.type === 'image'
      ? { type: 'input_image', image: dataUrl, detail: 'auto' }
      : { type: 'input_file', file: dataUrl, filename: attachment.name };
  }
}

//1. The MsSuzie helper in the ChatKit window. It reads its editable system prompt each turn.
//2. Replies go through OpenaiService, so usage records, traces, and prompt caching all apply.
//3. A tool that needs approval pauses the run and shows Approve and Decline buttons.
@Injectable()
export class MsSuzieChatKitService extends ChatKitService<ChatKitContext> {
  private helper?: Agent;

  constructor(
    readonly chatkitStore: ChatKitStore,
    readonly chatkitAttachments: ChatKitAttachmentStore,
    private readonly openai: OpenaiService,
    private readonly systemPrompts: SystemPromptsService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super(chatkitStore, chatkitAttachments);
  }

  // Build the helper once, then snapshot the editable instructions for each turn.
  agent() {
    this.helper ??= this.openai.createAgent(
      'MsSuzie',
      this.systemPrompts.forAgent('mssuzie'),
    ) as unknown as Agent;
    return this.helper;
  }

  private async configuredAgent() {
    const prompt = await this.systemPrompts.get('mssuzie');
    return {
      agent: this.agent().clone({ instructions: prompt.content }),
      agentVersion: AGENT_VERSION,
    };
  }

  async recoverOperation(
    threadId: string,
    recovery: Parameters<ChatKitService<ChatKitContext>['recoverOperation']>[1],
    context: ChatKitContext,
  ) {
    return this.prisma.withLock(`chatkit:${threadId}`, () =>
      super.recoverOperation(threadId, recovery, context),
    );
  }

  // Trusted operator entry point after checking whether the interrupted action had an effect.
  async recoverApproval(
    threadId: string,
    runId: string,
    recovery: { version: number; note: string },
    context: ChatKitContext,
  ): Promise<WidgetItem> {
    if (!z.uuid().safeParse(runId).success)
      throw new InvalidRequestError('The run id must be a UUID.');
    requireRecoveryNote(recovery.note);
    return this.prisma.withLock(`chatkit:${threadId}`, async () => {
      const thread = await this.store.loadThread(threadId, context);
      const owned = await this.prisma.connection.pausedRun.findFirst({
        where: {
          id: runId,
          chatkitThreadId: threadId,
          ownerId: context.userId,
        },
        select: { version: true },
      });
      if (!owned) throw new NotFoundError('Approval not found.');
      if (owned.version !== recovery.version)
        throw new ConflictException(
          'This approval changed since it was checked. Reload the approvals list.',
        );
      const { agent, agentVersion } = await this.configuredAgent();
      const checkpoint = this.checkpointCard(thread, context);
      await this.openai.recoverRun(agent, runId, {
        ...recovery,
        ownerId: context.userId,
        chatkitThreadId: threadId,
        agentVersion,
        onCheckpoint: checkpoint.save,
      });
      return checkpoint.item!;
    });
  }

  //1. Called before the protocol changes history for a new turn or retry.
  //2. A new message is a "no" to a waiting approval: it is cancelled, and nothing runs.
  //3. An interrupted action may already have happened, so the chat waits for an admin check.
  async prepareRespond(
    thread: ThreadMetadata,
    _input: UserMessageItem | undefined,
    context: ChatKitContext,
  ) {
    await this.store.loadThread(thread.id, context);
    const open = await this.prisma.connection.pausedRun.findMany({
      where: {
        chatkitThreadId: thread.id,
        status: { in: ['waiting', 'running', 'recovery_required', 'taken'] },
      },
      select: { id: true, status: true, version: true },
    });
    if (open.some((run) => run.status !== 'waiting'))
      throw new CustomStreamError(CHAT_PAUSED);
    // Sent after each commit, so the open window shows "Declined." at once.
    const events: ThreadStreamEvent[] = [];
    for (const run of open) {
      const closed = await this.closeApproval(
        thread.id,
        run,
        DECLINED,
        context,
      );
      if (closed) events.push({ type: 'thread.item.replaced', item: closed });
    }
    return events;
  }

  async *respond(
    thread: ThreadMetadata,
    input: UserMessageItem | undefined,
    context: ChatKitContext,
  ): AsyncGenerator<ThreadStreamEvent> {
    // A new thread is named after its first message. thread.updated is sent automatically.
    if (input && !thread.title) thread.title = titleOf(input);
    const recent = await this.store.loadThreadItems(
      thread.id,
      null,
      HISTORY_ITEMS,
      'desc',
      context,
    );
    const converter = new AttachmentConverter(
      this.chatkitStore,
      context.userId,
    );
    const history = await converter.toAgentInput(recent.data.reverse());
    const agentContext = this.agentContext(thread, context);
    const checkpoint = this.checkpointCard(thread, context);
    const { agent, agentVersion } = await this.configuredAgent();
    const result = await this.openai.runAgent(history, agent, {
      stream: true,
      context: agentContext,
      userId: context.userId,
      ownerId: context.userId,
      agentVersion,
      chatkitThreadId: thread.id,
      onCheckpoint: checkpoint.save,
      promptCacheKey: thread.id,
      groupId: thread.id,
      workflowName: 'chatkit-turn',
      ...(context.signal && { signal: context.signal }),
    });
    yield* this.finish(agentContext, result, checkpoint);
  }

  //1. Approve or decline a paused run from its card. Only the run's owner can answer it.
  //2. The card is replaced with the answer, then the helper carries on.
  async *action(
    thread: ThreadMetadata,
    action: Action,
    sender: WidgetItem | undefined,
    context: ChatKitContext,
  ): AsyncGenerator<ThreadStreamEvent> {
    const parsed = approvalAction.safeParse(action);
    if (!parsed.success)
      throw new CustomStreamError('This action is not supported.');
    const approved = parsed.data.type === 'approval.approve';
    const run = {
      id: parsed.data.payload.runId,
      version: parsed.data.payload.version,
    };
    const { agent, agentVersion } = await this.configuredAgent();
    let state: RunState<unknown, Agent>;
    let card: WidgetItem;
    try {
      await this.store.loadThread(thread.id, context);
      const expectedId = approvalItemId(run.id, run.version);
      if (sender && sender.id !== expectedId)
        throw new Error('Wrong approval card.');
      const stored = await this.store.loadItem(thread.id, expectedId, context);
      if (stored.type !== 'widget') throw new Error('Wrong approval card.');
      card = stored;
      state = await this.openai.loadRun(agent, run.id, {
        ownerId: context.userId,
        agentVersion,
        chatkitThreadId: thread.id,
        version: run.version,
      });
    } catch (error) {
      // Saved before an update to the helper's tools: it can never run, so it is closed.
      // A finished old run cannot be cancelled; that reads as already answered.
      if (error instanceof AgentVersionMismatchError) {
        const closed = await this.closeApproval(
          thread.id,
          run,
          EXPIRED,
          context,
        ).catch(() => undefined);
        if (closed) {
          yield { type: 'thread.item.replaced', item: closed };
          return;
        }
      }
      throw new CustomStreamError('This request was already answered.');
    }
    if (approved) this.openai.approve({ state });
    else this.openai.reject({ state }, { message: 'The user declined.' });
    const answered = {
      ...card,
      widget: answeredCard(approved ? APPROVED : DECLINED),
    };
    const agentContext = this.agentContext(thread, context);
    // The saved state keeps only the thread id. Give the run its live ChatKit context back.
    state._context.context = agentContext;
    const checkpoint = this.checkpointCard(thread, context);
    const result = await this.openai.resumeAgent(agent, state, {
      stream: true,
      onCheckpoint: checkpoint.save,
      onClaim: () => this.store.saveItem(thread.id, answered, context),
      ...(context.signal && { signal: context.signal }),
    });
    try {
      yield { type: 'thread.item.replaced', item: answered };
      yield* this.finish(agentContext, result, checkpoint);
    } finally {
      await result.completed;
    }
  }

  // Saved for evals. Only feedback on the user's own thread is kept.
  async addFeedback(
    threadId: string,
    itemIds: string[],
    kind: FeedbackKind,
    context: ChatKitContext,
  ) {
    await this.prisma.transaction(async (tx) => {
      await this.store.loadThread(threadId, context);
      for (const id of itemIds)
        await this.store.loadItem(threadId, id, context);
      await tx.chatkitFeedback.create({
        data: { userId: context.userId, threadId, itemIds, kind },
      });
    });
  }

  async transcribe(audio: AudioInput): Promise<TranscriptionResult> {
    const mediaType = audio.mime_type.split(';')[0].trim();
    const extension = mediaType.split('/')[1] ?? 'webm';
    const result = await this.openai.client().audio.transcriptions.create({
      file: await toFile(audio.data, `dictation.${extension}`, {
        type: mediaType,
      }),
      model:
        this.config.get<string>('CHATKIT_TRANSCRIPTION_MODEL') ??
        DEFAULT_TRANSCRIPTION_MODEL,
    });
    return { text: result.text };
  }

  private agentContext(thread: ThreadMetadata, context: ChatKitContext) {
    return new AgentContext({
      thread,
      store: this.store,
      requestContext: context,
    });
  }

  // Cancels a waiting approval without running it, then shows the outcome on its card.
  private async closeApproval(
    threadId: string,
    run: { id: string; version: number },
    outcome: string,
    context: ChatKitContext,
  ) {
    // The card belongs to the version being closed; cancelling moves the version on.
    const card = await this.store
      .loadItem(threadId, approvalItemId(run.id, run.version), context)
      .catch((error: unknown) => {
        // A card deleted with its message is fine; the run is still cancelled.
        if (error instanceof NotFoundError) return undefined;
        throw error;
      });
    const closed: WidgetItem | undefined =
      card?.type === 'widget'
        ? { ...card, widget: answeredCard(outcome) }
        : undefined;
    // The checkpoint and its card commit together, or neither changes.
    await this.openai.cancelRun(this.agent(), run.id, {
      ownerId: context.userId,
      chatkitThreadId: threadId,
      version: run.version,
      ...(closed && {
        onCancel: () => this.store.saveItem(threadId, closed, context),
      }),
    });
    return closed;
  }

  private checkpointCard(thread: ThreadMetadata, context: ChatKitContext) {
    const checkpoint: {
      item?: WidgetItem;
      save: NonNullable<RunAgentOptions['onCheckpoint']>;
    } = {
      save: async ({ id, version }, result) => {
        const item: WidgetItem = {
          type: 'widget',
          id: approvalItemId(id, version),
          thread_id: thread.id,
          created_at: new Date().toISOString(),
          copy_text: 'Approve this action?',
          widget: approvalCard(
            id,
            (result.interruptions ?? []).map((call) => ({
              name: call.name ?? 'action',
              arguments: call.arguments ?? '',
            })),
            version,
          ),
        };
        await this.store.addThreadItem(thread.id, item, context);
        checkpoint.item = item;
      },
    };
    return checkpoint;
  }

  // The checkpoint and card are committed before the card is delivered to the client.
  private async *finish(
    agentContext: AgentContext<ChatKitContext>,
    result: StreamedRunResult<any, any>,
    checkpoint: { item?: WidgetItem },
  ): AsyncGenerator<ThreadStreamEvent> {
    try {
      yield* streamAgentResponse(agentContext, result);
    } finally {
      await result.completed;
    }
    if (checkpoint.item)
      yield { type: 'thread.item.done', item: checkpoint.item };
  }
}

function titleOf(input: UserMessageItem) {
  const text = input.content
    .map((part) => (part.type === 'input_text' ? part.text : `@${part.text}`))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'New chat';
  return text.length > TITLE_LENGTH
    ? `${text.slice(0, TITLE_LENGTH - 1)}…`
    : text;
}

// One card per pause, listing what the helper wants to do.
export function approvalCard(
  runId: string,
  calls: { name: string; arguments: string }[],
  version: number,
): WidgetRoot {
  return {
    type: 'Card',
    size: 'md',
    children: [
      { type: 'Title', value: 'Approve this action?', size: 'sm' },
      ...calls.map((call) => ({
        type: 'Text' as const,
        value: `${call.name}: ${call.arguments}`.slice(0, 500),
        size: 'sm' as const,
      })),
    ],
    confirm: {
      label: 'Approve',
      action: actionConfig(
        'approval.approve',
        { runId, version },
        { loadingBehavior: 'container' },
      ),
    },
    cancel: {
      label: 'Decline',
      action: actionConfig(
        'approval.reject',
        { runId, version },
        { loadingBehavior: 'container' },
      ),
    },
  } as WidgetRoot;
}

function answeredCard(outcome: string): WidgetRoot {
  return {
    type: 'Card',
    size: 'md',
    children: [
      {
        type: 'Text',
        value: outcome,
        size: 'sm',
      },
    ],
  } as WidgetRoot;
}

function approvalItemId(runId: string, version: number) {
  return `msg_approval_${runId.replaceAll('-', '')}_${version}`;
}
