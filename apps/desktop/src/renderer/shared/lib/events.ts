import { z } from 'zod';

export const EngineEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('playback.state'), state: z.any() }),
  z.object({
    type: z.literal('buffer.state'),
    bufferedMs: z.number(),
    status: z.string().optional(),
    targetMs: z.number().optional(),
  }),
  z.object({
    type: z.literal('stream.state'),
    status: z.string(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal('spectrum.data'), data: z.array(z.number()) }),
  z.object({
    type: z.literal('engine.status'),
    connected: z.boolean(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
  }),
]);

export type EngineEvent = z.infer<typeof EngineEvent>;
