import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Composio, type ToolRouterSession } from '@composio/core';
import { OpenAIAgentsProvider } from '@composio/openai-agents';
import { tool, type Tool } from '@openai/agents';
import { PrismaService } from '../prisma/prisma.service.js';

const LOOKUP_TOOLS = new Set([
  'COMPOSIO_SEARCH_TOOLS',
  'COMPOSIO_GET_TOOL_SCHEMAS',
  'COMPOSIO_MANAGE_CONNECTIONS',
  'COMPOSIO_WAIT_FOR_CONNECTIONS',
]);
type ConnectedSession = Awaited<
  ReturnType<Composio<OpenAIAgentsProvider>['create']>
>;

// Retain identities for reconciliation, never remote errors containing customer data.
export class ComposioActionError extends Error {
  constructor(
    readonly sessionId: string,
    readonly toolName: string,
    readonly callId?: string,
    readonly logId?: string,
  ) {
    super('The Composio action needs reconciliation before retry.');
    this.name = 'ComposioActionError';
  }
}

@Injectable()
export class ComposioService implements OnModuleDestroy {
  private client?: Composio<OpenAIAgentsProvider>;
  private readonly logger = new Logger(ComposioService.name);
  private readonly pending = new Map<string, Promise<ConnectedSession>>();
  private readonly shutdown = new AbortController();
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  get enabled() {
    return (
      this.config.get<string>('NODE_ENV') !== 'test' &&
      this.config.get<boolean>('COMPOSIO_ENABLED') === true
    );
  }
  onModuleDestroy() {
    this.shutdown.abort(new Error('Application is shutting down.'));
  }

  // userId comes from authenticated server context; clients never select a session id.
  async tools(userId: string): Promise<{ tools: Tool[] }> {
    const owner = this.ownerId(userId);
    if (!this.enabled)
      throw new Error('Composio is off. Set COMPOSIO_API_KEY to turn it on.');
    // The factory's Session interface omits request options exposed by the concrete public class.
    const session = (await this.session(owner)) as ToolRouterSession<
      ReturnType<OpenAIAgentsProvider['wrapTools']>,
      ReturnType<OpenAIAgentsProvider['wrapTool']>,
      OpenAIAgentsProvider
    >;
    const definitions = (await session.tools(
      undefined,
      this.requestOptions(),
    )) as Tool[];
    return {
      tools: definitions.map((definition) => {
        if (definition.type !== 'function')
          throw new Error('Unsupported Composio tool type.');
        const action = !LOOKUP_TOOLS.has(definition.name);
        return tool({
          name: definition.name,
          description: definition.description,
          parameters: { ...definition.parameters, additionalProperties: true },
          strict: false,
          needsApproval: action,
          // A failed lookup goes back to the model, which can try again. A failed action
          // stops the run, because nobody knows whether it already happened.
          ...(action && { errorFunction: null }),
          execute: async (input, _context, details) => {
            const request = this.requestOptions(details?.signal);
            request.signal.throwIfAborted();
            try {
              // The explicit session API carries cancellation and disables execution retries.
              const result = await session.execute(
                definition.name,
                input as Record<string, unknown>,
                undefined,
                request,
              );
              if (
                action &&
                (result.resultType === 'failed' ||
                  (result.resultType === 'blocked' &&
                    result.blockReason?.type !== 'request_blocked') ||
                  hasBatchFailure(definition.name, result.data))
              )
                throw new ComposioActionError(
                  session.sessionId,
                  definition.name,
                  details?.toolCall?.callId,
                  result.logId,
                );
              return result;
            } catch (error) {
              if (!action || error instanceof ComposioActionError) throw error;
              throw new ComposioActionError(
                session.sessionId,
                definition.name,
                details?.toolCall?.callId,
              );
            }
          },
        });
      }),
    };
  }

  //1. Reuse the user's stored session. If Composio no longer has it, make a new one.
  //2. Making a session never touches the user's apps, so a failed or unclear attempt is
  //   simply tried again. The worst case is one unused session at Composio.
  //3. One server makes the session at a time per user; calls in this server share it.
  //4. Without DATABASE_URL, each call makes a new session. Connections belong to the user.
  private session(userId: string): Promise<ConnectedSession> {
    if (!this.config.get<string>('DATABASE_URL'))
      return this.composio().create(userId, undefined, this.requestOptions());
    const pending = this.pending.get(userId);
    if (pending) return pending;
    const work = this.prisma.withLock(`composio:${userId}`, async (signal) => {
      const client = this.composio();
      const stored = await this.prisma.db.composioSession.findUnique({
        where: { userId },
      });
      if (stored) {
        try {
          return await client.use(
            stored.sessionId,
            undefined,
            this.requestOptions(signal),
          );
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      const created = await client.create(
        userId,
        undefined,
        this.requestOptions(signal),
      );
      try {
        await this.prisma.transaction((tx) =>
          tx.composioSession.upsert({
            where: { userId },
            create: { userId, sessionId: created.sessionId },
            update: { sessionId: created.sessionId },
          }),
        );
      } catch (error) {
        // Not saved, so nothing will reuse it. Remove it and let the next call try again.
        await client.sessions
          .delete(created.sessionId, this.requestOptions())
          .catch(() =>
            this.logger.warn(
              'An unsaved Composio session could not be deleted.',
            ),
          );
        throw error;
      }
      return created;
    });
    this.pending.set(userId, work);
    void work.finally(() => this.pending.delete(userId)).catch(() => {});
    return work;
  }

  private requestOptions(signal?: AbortSignal) {
    return {
      signal: AbortSignal.any([
        this.shutdown.signal,
        AbortSignal.timeout(120_000),
        ...(signal ? [signal] : []),
      ]),
      maxRetries: 0,
    };
  }
  private ownerId(userId: string) {
    const id = userId.trim();
    if (!id || id === 'default')
      throw new Error('Composio needs a stable user id.');
    return id;
  }
  private composio() {
    this.client ??= new Composio({
      apiKey: this.config.get<string>('COMPOSIO_API_KEY'),
      provider: new OpenAIAgentsProvider(),
    });
    return this.client;
  }
}

// The batch wrapper can complete while individual app actions fail. Inspect only
// its execution envelope, never similarly named fields inside application data.
function hasBatchFailure(name: string, data: Record<string, unknown>) {
  if (name !== 'COMPOSIO_MULTI_EXECUTE_TOOL') return false;
  if (typeof data.error_count === 'number' && data.error_count > 0) return true;
  if (!Array.isArray(data.results)) return false;
  return data.results.some((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.tool_slug !== 'string') return false;
    const response = isRecord(entry.response) ? entry.response : undefined;
    return (
      response?.successful === false ||
      hasErrorText(entry.error) ||
      hasErrorText(response?.error)
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNotFound(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 404
  );
}
