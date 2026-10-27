import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Composio } from '@composio/core';
import { OpenAIAgentsProvider } from '@composio/openai-agents';
import type { Tool } from '@openai/agents';
import { isUniqueViolation, PrismaService } from '../prisma/prisma.service.js';

// These only look things up or make a connect link. Every other tool acts in the user's
// apps or runs code, so it waits for a person to approve, including tools Composio adds later.
const LOOKUP_TOOLS = new Set([
  'COMPOSIO_SEARCH_TOOLS',
  'COMPOSIO_GET_TOOL_SCHEMAS',
  'COMPOSIO_MANAGE_CONNECTIONS',
  'COMPOSIO_WAIT_FOR_CONNECTIONS',
]);

//1. Off until COMPOSIO_API_KEY is set. Test runs never call Composio.
//2. The session belongs to the user id, and its id stays on the server.
//3. A tool that sends, posts, changes, or runs code pauses for approval first.
@Injectable()
export class ComposioService {
  private client?: Composio<OpenAIAgentsProvider>;
  private readonly logger = new Logger(ComposioService.name);

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

  // Tools for createAgent. userId must come from login, never from the request body.
  async tools(userId: string): Promise<{ tools: Tool[] }> {
    const ownerId = this.ownerId(userId);
    if (!this.enabled) {
      throw new Error('Composio is off. Set COMPOSIO_API_KEY to turn it on.');
    }
    const session = await this.session(ownerId);
    const tools = (await session.tools()) as Tool[];
    return { tools: tools.map(withApproval) };
  }

  //1. Reuse the user's stored session. If Composio no longer has it, make a new one.
  //2. Two first messages at once both create a session. One insert wins; the other
  //   deletes its own session and uses the winner's.
  //3. Without DATABASE_URL, each call makes a new session. Connections belong to the
  //   user, not the session, so nothing is lost.
  private async session(userId: string) {
    const composio = this.composio();
    if (!this.config.get<string>('DATABASE_URL'))
      return await composio.create(userId);

    const stored = await this.prisma.db.composioSession.findUnique({
      where: { userId },
    });
    if (stored) {
      try {
        return await composio.use(stored.sessionId);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await this.prisma.db.composioSession.deleteMany({
          where: { userId, sessionId: stored.sessionId },
        });
      }
    }

    const created = await composio.create(userId);
    try {
      await this.prisma.db.composioSession.create({
        data: { userId, sessionId: created.sessionId },
      });
      return created;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await composio.sessions
        .delete(created.sessionId)
        .catch(() =>
          this.logger.warn('An unused Composio session could not be deleted.'),
        );
      const winner = await this.prisma.db.composioSession.findUniqueOrThrow({
        where: { userId },
      });
      return await composio.use(winner.sessionId);
    }
  }

  private ownerId(userId: string) {
    const ownerId = userId.trim();
    if (!ownerId || ownerId === 'default') {
      throw new Error('Composio needs a stable user id.');
    }
    return ownerId;
  }

  // The key comes from the checked settings, trimmed, like every other key.
  private composio() {
    this.client ??= new Composio({
      apiKey: this.config.get<string>('COMPOSIO_API_KEY'),
      provider: new OpenAIAgentsProvider(),
    });
    return this.client;
  }
}

function withApproval(tool: Tool): Tool {
  if (tool.type !== 'function' || LOOKUP_TOOLS.has(tool.name)) return tool;
  return { ...tool, needsApproval: async () => true };
}

function isNotFound(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 404
  );
}
