import type { Widgets } from '@openai/chatkit';

// The ChatKit server protocol, ported from openai/chatkit-python (chatkit/types.py, v1.6.5).
// Field names stay snake_case because that is what the ChatKit client sends and expects.

export type WidgetRoot = Widgets.WidgetRoot;
export type WidgetComponent = Widgets.WidgetComponent;
export type IconName = Widgets.WidgetIcon;

export type Page<T> = { data: T[]; has_more: boolean; after?: string | null };

// Actions

export type ActionHandler = 'client' | 'server';
export type LoadingBehavior = 'auto' | 'none' | 'self' | 'container';

// What a widget node carries, such as Button.onClickAction or Card.confirm.action.
export type ActionConfig = {
  type: string;
  payload?: unknown;
  handler?: ActionHandler;
  loadingBehavior?: LoadingBehavior;
  streaming?: boolean;
};

// What the client sends back. Untrusted: validate type and payload before acting.
export type Action<TType extends string = string, TPayload = unknown> = {
  type: TType;
  payload?: TPayload;
};

// Requests

type Req<TType extends string, TParams> = {
  type: TType;
  params: TParams;
  metadata?: Record<string, unknown>;
};

export type InferenceOptions = {
  tool_choice?: { id: string } | null;
  model?: string | null;
};

export type UserMessageTextContent = { type: 'input_text'; text: string };
export type UserMessageTagContent = {
  type: 'input_tag';
  id: string;
  text: string;
  data: Record<string, unknown>;
  group?: string | null;
  interactive?: boolean;
};
export type UserMessageContent = UserMessageTextContent | UserMessageTagContent;

export type UserMessageInput = {
  content: UserMessageContent[];
  attachments: string[];
  quoted_text?: string | null;
  inference_options: InferenceOptions;
};

export type StructuredInputSubmission = {
  status?: 'answered' | 'skipped';
  answers?: Record<string, { values?: string[]; skipped?: boolean }>;
};

export type ThreadsGetByIdReq = Req<'threads.get_by_id', { thread_id: string }>;
export type ThreadsCreateReq = Req<
  'threads.create',
  { input: UserMessageInput }
>;
export type ThreadsListReq = Req<
  'threads.list',
  { limit?: number | null; order?: 'asc' | 'desc'; after?: string | null }
>;
export type ThreadsAddUserMessageReq = Req<
  'threads.add_user_message',
  { input: UserMessageInput; thread_id: string }
>;
export type ThreadsAddClientToolOutputReq = Req<
  'threads.add_client_tool_output',
  { thread_id: string; result: unknown }
>;
export type ThreadsAddStructuredInputReq = Req<
  'threads.add_structured_input',
  { thread_id: string; item_id: string; input: StructuredInputSubmission }
>;
type CustomActionParams = {
  thread_id: string;
  item_id?: string | null;
  action: Action;
};
export type ThreadsCustomActionReq = Req<
  'threads.custom_action',
  CustomActionParams
>;
export type ThreadsSyncCustomActionReq = Req<
  'threads.sync_custom_action',
  CustomActionParams
>;
export type ThreadsRetryAfterItemReq = Req<
  'threads.retry_after_item',
  { thread_id: string; item_id: string }
>;
export type ItemsFeedbackReq = Req<
  'items.feedback',
  { thread_id: string; item_ids: string[]; kind: FeedbackKind }
>;
export type AttachmentsDeleteReq = Req<
  'attachments.delete',
  { attachment_id: string }
>;
export type AttachmentCreateParams = {
  name: string;
  size: number;
  mime_type: string;
};
export type AttachmentsCreateReq = Req<
  'attachments.create',
  AttachmentCreateParams
>;
export type InputTranscribeReq = Req<
  'input.transcribe',
  { audio_base64: string; mime_type: string }
>;
export type ItemsListReq = Req<
  'items.list',
  {
    thread_id: string;
    limit?: number | null;
    order?: 'asc' | 'desc';
    after?: string | null;
  }
>;
export type ThreadsUpdateReq = Req<
  'threads.update',
  { thread_id: string; title: string }
>;
export type ThreadsDeleteReq = Req<'threads.delete', { thread_id: string }>;

export type StreamingReq =
  | ThreadsCreateReq
  | ThreadsAddUserMessageReq
  | ThreadsAddClientToolOutputReq
  | ThreadsAddStructuredInputReq
  | ThreadsRetryAfterItemReq
  | ThreadsCustomActionReq;

export type NonStreamingReq =
  | ThreadsGetByIdReq
  | ThreadsListReq
  | ItemsListReq
  | ItemsFeedbackReq
  | AttachmentsCreateReq
  | AttachmentsDeleteReq
  | ThreadsUpdateReq
  | ThreadsDeleteReq
  | InputTranscribeReq
  | ThreadsSyncCustomActionReq;

export type ChatKitReq = StreamingReq | NonStreamingReq;

export const STREAMING_REQUEST_TYPES: ReadonlySet<string> = new Set([
  'threads.create',
  'threads.add_user_message',
  'threads.add_client_tool_output',
  'threads.add_structured_input',
  'threads.retry_after_item',
  'threads.custom_action',
]);

export const REQUEST_TYPES: ReadonlySet<string> = new Set([
  ...STREAMING_REQUEST_TYPES,
  'threads.get_by_id',
  'threads.list',
  'items.list',
  'items.feedback',
  'attachments.create',
  'attachments.delete',
  'threads.update',
  'threads.delete',
  'input.transcribe',
  'threads.sync_custom_action',
]);

export function isStreamingReq(request: ChatKitReq): request is StreamingReq {
  return STREAMING_REQUEST_TYPES.has(request.type);
}

export type AudioInput = { data: Buffer; mime_type: string };
export type TranscriptionResult = { text: string };
export type SyncCustomActionResponse = { updated_item?: ThreadItem | null };

// Threads

export type ThreadStatus =
  | { type: 'active' }
  | { type: 'locked'; reason?: string | null }
  | { type: 'closed'; reason?: string | null };

export type ThreadMetadata = {
  id: string;
  title?: string | null;
  created_at: string;
  status: ThreadStatus;
  allowed_image_domains?: string[] | null;
  // Server-side state, never sent to the client.
  metadata: Record<string, unknown>;
};

export type Thread = Omit<ThreadMetadata, 'metadata'> & {
  items: Page<ThreadItem>;
};

// Thread items

type ItemBase = { id: string; thread_id: string; created_at: string };

export type Annotation = {
  type: 'annotation';
  source: URLSource | FileSource | EntitySource;
  index?: number | null;
};

export type AssistantMessageContent = {
  type: 'output_text';
  text: string;
  annotations: Annotation[];
};

export type AttachmentUploadDescriptor = {
  url: string;
  method: 'POST' | 'PUT';
  headers?: Record<string, string>;
};

type AttachmentBase = {
  id: string;
  name: string;
  mime_type: string;
  upload_descriptor?: AttachmentUploadDescriptor | null;
  thread_id?: string | null;
  // Integration-only. Never returned to the client.
  metadata?: Record<string, unknown> | null;
};
export type FileAttachment = AttachmentBase & { type: 'file' };
export type ImageAttachment = AttachmentBase & {
  type: 'image';
  preview_url: string;
};
export type Attachment = FileAttachment | ImageAttachment;

export type UserMessageItem = ItemBase & {
  type: 'user_message';
  content: UserMessageContent[];
  attachments: Attachment[];
  quoted_text?: string | null;
  inference_options: InferenceOptions;
};
export type AssistantMessageItem = ItemBase & {
  type: 'assistant_message';
  content: AssistantMessageContent[];
};
export type ClientToolCallItem = ItemBase & {
  type: 'client_tool_call';
  status: 'pending' | 'completed';
  call_id: string;
  name: string;
  arguments: Record<string, unknown>;
  output?: unknown;
};
export type WidgetItem = ItemBase & {
  type: 'widget';
  widget: WidgetRoot;
  copy_text?: string | null;
};
export type GeneratedImage = { id: string; url: string };
export type GeneratedImageItem = ItemBase & {
  type: 'generated_image';
  image?: GeneratedImage | null;
};
export type StructuredInputAnswer = { values: string[]; skipped: boolean };
type StructuredInputBase = {
  id: string;
  question: string;
  answer?: StructuredInputAnswer | null;
};
export type StructuredInput =
  | (StructuredInputBase & {
      type: 'multiple_choice';
      options: { value: string }[];
      multiple?: boolean;
    })
  | (StructuredInputBase & { type: 'freeform'; description?: string | null });
export type StructuredInputItem = ItemBase & {
  type: 'structured_input';
  status: 'pending' | 'answered' | 'skipped';
  inputs: StructuredInput[];
};
export type TaskItem = ItemBase & { type: 'task'; task: Task };
export type WorkflowItem = ItemBase & { type: 'workflow'; workflow: Workflow };
export type EndOfTurnItem = ItemBase & { type: 'end_of_turn' };
// Never sent to the client. Context for the model at a place in the thread.
export type HiddenContextItem = ItemBase & {
  type: 'hidden_context_item';
  content: unknown;
};
export type SDKHiddenContextItem = ItemBase & {
  type: 'sdk_hidden_context';
  content: string;
};

export type ThreadItem =
  | UserMessageItem
  | AssistantMessageItem
  | ClientToolCallItem
  | WidgetItem
  | GeneratedImageItem
  | StructuredInputItem
  | WorkflowItem
  | TaskItem
  | HiddenContextItem
  | SDKHiddenContextItem
  | EndOfTurnItem;

export function isHiddenItem(item: ThreadItem) {
  return (
    item.type === 'hidden_context_item' || item.type === 'sdk_hidden_context'
  );
}

// Workflows and tasks

type TaskBase = { status_indicator?: 'none' | 'loading' | 'complete' };
export type CustomTask = TaskBase & {
  type: 'custom';
  title?: string | null;
  icon?: IconName | null;
  content?: string | null;
};
export type SearchTask = TaskBase & {
  type: 'web_search';
  title?: string | null;
  title_query?: string | null;
  queries?: string[];
  sources?: URLSource[];
};
export type ThoughtTask = TaskBase & {
  type: 'thought';
  title?: string | null;
  content: string;
};
export type FileTask = TaskBase & {
  type: 'file';
  title?: string | null;
  sources?: FileSource[];
};
export type ImageTask = TaskBase & { type: 'image'; title?: string | null };
export type Task = CustomTask | SearchTask | ThoughtTask | FileTask | ImageTask;

export type WorkflowSummary =
  { title: string; icon?: IconName | null } | { duration: number };
export type Workflow = {
  type: 'custom' | 'reasoning';
  tasks: Task[];
  summary?: WorkflowSummary | null;
  expanded?: boolean;
};

// Sources

type SourceBase = {
  title: string;
  description?: string | null;
  timestamp?: string | null;
  group?: string | null;
};
export type FileSource = SourceBase & { type: 'file'; filename: string };
export type URLSource = SourceBase & {
  type: 'url';
  url: string;
  attribution?: string | null;
};
export type EntitySource = SourceBase & {
  type: 'entity';
  id: string;
  icon?: IconName | null;
  label?: string | null;
  inline_label?: string | null;
  interactive?: boolean;
  data?: Record<string, unknown>;
};

export type FeedbackKind = 'positive' | 'negative';

// Item updates

export type ThreadItemUpdate =
  | {
      type: 'assistant_message.content_part.added';
      content_index: number;
      content: AssistantMessageContent;
    }
  | {
      type: 'assistant_message.content_part.text_delta';
      content_index: number;
      delta: string;
    }
  | {
      type: 'assistant_message.content_part.annotation_added';
      content_index: number;
      annotation_index: number;
      annotation: Annotation;
    }
  | {
      type: 'assistant_message.content_part.done';
      content_index: number;
      content: AssistantMessageContent;
    }
  | {
      type: 'widget.streaming_text.value_delta';
      component_id: string;
      delta: string;
      done: boolean;
    }
  | { type: 'widget.root.updated'; widget: WidgetRoot }
  | {
      type: 'widget.component.updated';
      component_id: string;
      component: WidgetComponent;
    }
  | { type: 'workflow.task.added'; task_index: number; task: Task }
  | { type: 'workflow.task.updated'; task_index: number; task: Task }
  | {
      type: 'generated_image.updated';
      image: GeneratedImage;
      progress?: number | null;
    };

// Stream events

export type StreamOptions = { allow_cancel: boolean };

export type ThreadStreamEvent =
  | { type: 'thread.created'; thread: Thread }
  | { type: 'thread.updated'; thread: Thread }
  | { type: 'thread.item.added'; item: ThreadItem }
  | { type: 'thread.item.updated'; item_id: string; update: ThreadItemUpdate }
  | { type: 'thread.item.done'; item: ThreadItem }
  | { type: 'thread.item.removed'; item_id: string }
  | { type: 'thread.item.replaced'; item: ThreadItem }
  | { type: 'stream_options'; stream_options: StreamOptions }
  | { type: 'progress_update'; icon?: IconName | null; text: string }
  | { type: 'client_effect'; name: string; data: Record<string, unknown> }
  | {
      type: 'error';
      code: string;
      message?: string | null;
      allow_retry: boolean;
    }
  | {
      type: 'notice';
      level: 'info' | 'warning' | 'danger';
      message: string;
      title?: string | null;
    };

// Not a closed list. ChatKit maps known codes to localized messages.
export const ErrorCode = { STREAM_ERROR: 'stream.error' } as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// An error with a known code. The client shows its own localized message.
export class StreamError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly allowRetry = code === ErrorCode.STREAM_ERROR,
  ) {
    super(code);
    this.name = 'StreamError';
  }
}

// An error whose message is shown to the user as written. Localize it before throwing.
export class CustomStreamError extends Error {
  constructor(
    message: string,
    readonly allowRetry = false,
  ) {
    super(message);
    this.name = 'CustomStreamError';
  }
}

// A thread, item, or attachment that does not exist for this caller.
export class NotFoundError extends Error {
  constructor(message = 'Not found.') {
    super(message);
    this.name = 'NotFoundError';
  }
}
