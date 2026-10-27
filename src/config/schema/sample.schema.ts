import { z } from 'zod';

// A Sunny Bakery order. Pass it as schema and the agent fills it in.
export const sampleSchema = z.object({
  item: z.string(),
  quantity: z.number(),
  pickupDay: z.string(),
});
