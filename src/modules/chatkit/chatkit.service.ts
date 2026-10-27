import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RunState, type Agent, type StreamedRunResult } from '@openai/agents';
import { toFile } from 'openai';
import { z } from 'zod';
import {
  actionConfig,
  AgentContext,
  ChatKitService,
  CustomStreamError,
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
import { OpenaiService } from '@/lib/openai/openai.service.js';
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

// The approval buttons send these. The client is untrusted, so the shape is checked.
const approvalAction = z.object({
  type: z.enum(['approval.approve', 'approval.reject']),
  payload: z.object({ runId: z.uuid() }),
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

  // Built once. The system prompt is read fresh before each model call.
  agent() {
    this.helper ??= this.openai.createAgent(
      'MsSuzie',
      this.systemPrompts.forAgent('mssuzie'),
    ) as unknown as Agent;
    return this.helper;
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
    const result = await this.openai.runAgent(history, this.agent(), {
      stream: true,
      context: agentContext,
      userId: context.userId,
      promptCacheKey: thread.id,
      groupId: thread.id,
      workflowName: 'chatkit-turn',
      ...(context.signal && { signal: context.signal }),
    });
    yield* this.finish(thread, agentContext, result, context);
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
    const agent = this.agent();
    let state: RunState<unknown, Agent>;
    try {
      state = await this.openai.loadRun(agent, parsed.data.payload.runId, {
        ownerId: context.userId,
      });
    } catch {
      throw new CustomStreamError('This request was already answered.');
    }
    if (approved) this.openai.approve({ state });
    else this.openai.reject({ state }, { message: 'The user declined.' });
    if (sender)
      yield {
        type: 'thread.item.replaced',
        item: { ...sender, widget: answeredCard(approved) },
      };
    const agentContext = this.agentContext(thread, context);
    // The saved state keeps only the thread id. Give the run its live ChatKit context back.
    state._context.context = agentContext;
    const result = await this.openai.resumeAgent(agent, state, {
      stream: true,
      ...(context.signal && { signal: context.signal }),
    });
    yield* this.finish(thread, agentContext, result, context);
  }

  // Saved for evals. Only feedback on the user's own thread is kept.
  async addFeedback(
    threadId: string,
    itemIds: string[],
    kind: FeedbackKind,
    context: ChatKitContext,
  ) {
    await this.store.loadThread(threadId, context);
    await this.prisma.db.chatkitFeedback.create({
      data: { userId: context.userId, threadId, itemIds, kind },
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

  // Streams the run, then shows an approval card when a tool is waiting for a yes.
  private async *finish(
    thread: ThreadMetadata,
    agentContext: AgentContext<ChatKitContext>,
    result: StreamedRunResult<any, any>,
    context: ChatKitContext,
  ): AsyncGenerator<ThreadStreamEvent> {
    yield* streamAgentResponse(agentContext, result);
    await result.completed;
    if (!result.interruptions?.length) return;
    const runId = await this.openai.saveRun(result, {
      ownerId: context.userId,
      userId: context.userId,
    });
    yield {
      type: 'thread.item.done',
      item: {
        type: 'widget',
        id: this.store.generateItemId('message', thread, context),
        thread_id: thread.id,
        created_at: new Date().toISOString(),
        copy_text: 'Approve this action?',
        widget: approvalCard(
          runId,
          result.interruptions.map((call) => ({
            name: call.name ?? 'action',
            arguments: call.arguments ?? '',
          })),
        ),
      },
    };
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
        { runId },
        { loadingBehavior: 'container' },
      ),
    },
    cancel: {
      label: 'Decline',
      action: actionConfig(
        'approval.reject',
        { runId },
        { loadingBehavior: 'container' },
      ),
    },
  } as WidgetRoot;
}

function answeredCard(approved: boolean): WidgetRoot {
  return {
    type: 'Card',
    size: 'md',
    children: [
      {
        type: 'Text',
        value: approved ? 'Approved.' : 'Declined.',
        size: 'sm',
      },
    ],
  } as WidgetRoot;
}
