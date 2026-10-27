import { tool } from '@openai/agents';
import { z } from 'zod';

// Sample tool for testing
export const sampleTool = tool({
  name: 'history_fun_fact',
  description: 'Return a short history fact.',
  parameters: z.object({}),
  async execute() {
    return 'Sharks are older than trees.';
  },
});
