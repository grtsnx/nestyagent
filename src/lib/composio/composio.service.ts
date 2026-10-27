import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Composio } from '@composio/core';
import { OpenAIAgentsProvider } from '@composio/openai-agents';

//1. Off until COMPOSIO_API_KEY is set.
//2. Test runs never call Composio.
//3. One session belongs to one user. Pass its id back to keep the same connections.
@Injectable()
export class ComposioService {
  private client?: Composio<OpenAIAgentsProvider>;

  constructor(private readonly config: ConfigService) {}

  get enabled() {
    return (
      this.config.get<string>('NODE_ENV') !== 'test' &&
      this.config.get<boolean>('COMPOSIO_ENABLED') === true
    );
  }

  // Tools for createAgent. Store sessionId with the user and pass it on the next message.
  async tools(userId: string, options?: { sessionId?: string }) {
    const ownerId = this.ownerId(userId);
    if (!this.enabled) {
      throw new Error('Composio is off. Set COMPOSIO_API_KEY to turn it on.');
    }

    const session = options?.sessionId
      ? await this.composio().use(options.sessionId)
      : await this.composio().create(ownerId);

    return {
      sessionId: session.sessionId,
      tools: await session.tools(),
    };
  }

  private ownerId(userId: string) {
    const ownerId = userId.trim();
    if (!ownerId || ownerId === 'default') {
      throw new Error('Composio needs a stable user id.');
    }
    return ownerId;
  }

  // The SDK reads COMPOSIO_API_KEY from the environment.
  private composio() {
    this.client ??= new Composio({
      provider: new OpenAIAgentsProvider(),
    });
    return this.client;
  }
}
