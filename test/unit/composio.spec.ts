import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposioService } from '@/lib/composio/composio.service.js';

const { create, use, Composio, OpenAIAgentsProvider } = vi.hoisted(() => {
  const create = vi.fn();
  const use = vi.fn();
  const Composio = vi.fn(function Composio(
    this: { create: typeof create; use: typeof use },
    _config: { provider: object; apiKey?: string },
  ) {
    this.create = create;
    this.use = use;
  });
  const OpenAIAgentsProvider = vi.fn(function OpenAIAgentsProvider() {});
  return { create, use, Composio, OpenAIAgentsProvider };
});

vi.mock('@composio/core', () => ({ Composio }));
vi.mock('@composio/openai-agents', () => ({ OpenAIAgentsProvider }));

function service(values: Record<string, unknown>) {
  return new ComposioService(new ConfigService(values));
}

describe('ComposioService', () => {
  beforeEach(() => {
    create.mockReset();
    use.mockReset();
    Composio.mockClear();
    OpenAIAgentsProvider.mockClear();
  });

  it('stays off until the project key is configured', async () => {
    const composio = service({ NODE_ENV: 'development' });

    expect(composio.enabled).toBe(false);
    await expect(composio.tools('user_123')).rejects.toThrow(
      /COMPOSIO_API_KEY/,
    );
    expect(Composio).not.toHaveBeenCalled();
  });

  it('stays off during tests', async () => {
    const composio = service({ NODE_ENV: 'test', COMPOSIO_ENABLED: true });

    expect(composio.enabled).toBe(false);
    await expect(composio.tools('user_123')).rejects.toThrow(
      /COMPOSIO_API_KEY/,
    );
    expect(Composio).not.toHaveBeenCalled();
  });

  it('opens a session for one user and returns that session’s tools', async () => {
    const tools = [{ type: 'function', name: 'COMPOSIO_SEARCH_TOOLS' }];
    create.mockResolvedValue({
      sessionId: 'sess_1',
      tools: vi.fn().mockResolvedValue(tools),
    });
    const composio = service({
      NODE_ENV: 'development',
      COMPOSIO_ENABLED: true,
    });

    await expect(composio.tools('user_123')).resolves.toEqual({
      sessionId: 'sess_1',
      tools,
    });
    await composio.tools('user_123');

    expect(OpenAIAgentsProvider).toHaveBeenCalledOnce();
    expect(Composio).toHaveBeenCalledOnce();
    expect(Composio).toHaveBeenCalledWith({
      provider: expect.any(OpenAIAgentsProvider),
    });
    expect(Composio.mock.calls[0]?.[0]).not.toHaveProperty('apiKey');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith('user_123');
    expect(use).not.toHaveBeenCalled();
  });

  it('reuses a stored session instead of creating another', async () => {
    const tools = [{ type: 'function', name: 'COMPOSIO_SEARCH_TOOLS' }];
    use.mockResolvedValue({
      sessionId: 'sess_1',
      tools: vi.fn().mockResolvedValue(tools),
    });
    const composio = service({
      NODE_ENV: 'development',
      COMPOSIO_ENABLED: true,
    });

    await expect(
      composio.tools('user_123', { sessionId: 'sess_1' }),
    ).resolves.toEqual({ sessionId: 'sess_1', tools });
    expect(use).toHaveBeenCalledWith('sess_1');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a blank or shared user id before talking to Composio', async () => {
    const composio = service({
      NODE_ENV: 'development',
      COMPOSIO_ENABLED: true,
    });

    await expect(composio.tools('')).rejects.toThrow(/user id/);
    await expect(composio.tools(' default ')).rejects.toThrow(/user id/);
    expect(Composio).not.toHaveBeenCalled();
  });
});
