import { z } from 'zod';

export const sampleSchema = z.object({
  name: z.string(),
  date: z.string(),
  participants: z.array(z.string()),
});
