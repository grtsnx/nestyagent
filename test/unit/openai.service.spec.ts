import { ConfigService } from '@nestjs/config';
import { Agent, getHandoff, handoff } from '@openai/agents';
import { describe, expect, it } from 'vitest';
import { OpenaiService } from '@/lib/openai/openai.service.js';

function service() {
  return new OpenaiService({
    getOrThrow: () => 'sk-test',
  } as unknown as ConfigService);
}

describe('OpenaiService orchestration', () => {
  it('uses the agent name when the tool name is left out', () => {
    const summarizer = new Agent({
      name: 'Summarizer',
      instructions: 'Summarize the supplied text.',
    });

    const tool = service().asTool(summarizer);

    expect(tool.name).toBe('Summarizer');
  });

  it('uses a tool name and description when they are passed', () => {
    const summarizer = new Agent({
      name: 'Summarizer',
      instructions: 'Summarize the supplied text.',
    });

    const tool = service().asTool(summarizer, {
      toolName: 'summarize_text',
      toolDescription: 'Generate a concise summary of the supplied text.',
    });

    expect(tool.name).toBe('summarize_text');
    expect(tool.description).toBe(
      'Generate a concise summary of the supplied text.',
    );
  });

  it('returns the specialist who answered', () => {
    const triage = new Agent({ name: 'Triage', instructions: 'Route.' });
    const billing = new Agent({ name: 'Billing', instructions: 'Bill.' });

    expect(service().nextAgent({ lastAgent: billing }, triage)).toBe(billing);
  });

  it('returns the fallback when the run has no last agent', () => {
    const triage = new Agent({ name: 'Triage', instructions: 'Route.' });

    expect(service().nextAgent({}, triage)).toBe(triage);
    expect(service().nextAgent({ lastAgent: undefined }, triage)).toBe(triage);
  });

  it('passes a handoff with its own settings to the triage agent', () => {
    const refunds = new Agent({ name: 'Refunds', instructions: 'Refund.' });
    const billing = new Agent({ name: 'Billing', instructions: 'Bill.' });

    const triage = service().createTriageAgent(
      'Triage',
      'Route.',
      [billing, handoff(refunds, { toolNameOverride: 'refund_request' })],
      'Routes billing questions.',
    );

    expect(triage.handoffs).toHaveLength(2);
    expect(getHandoff(triage.handoffs[1]).toolName).toBe('refund_request');
  });
});
