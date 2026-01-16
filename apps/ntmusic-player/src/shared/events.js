const { z } = require('zod');

const EngineRawEvent = z.discriminatedUnion('type', [
    z.object({ type: z.literal('playback_state'), state: z.any() }),
    z.object({
        type: z.literal('buffer_state'),
        buffered_ms: z.number(),
        status: z.string().optional(),
        target_ms: z.number().optional()
    }),
    z.object({
        type: z.literal('stream_state'),
        status: z.string(),
        error: z.string().optional()
    }),
    z.object({ type: z.literal('spectrum_data'), data: z.array(z.number()) })
]);

const EngineEvent = z.discriminatedUnion('type', [
    z.object({ type: z.literal('playback.state'), state: z.any() }),
    z.object({
        type: z.literal('buffer.state'),
        bufferedMs: z.number(),
        status: z.string().optional(),
        targetMs: z.number().optional()
    }),
    z.object({
        type: z.literal('stream.state'),
        status: z.string(),
        error: z.string().optional()
    }),
    z.object({ type: z.literal('spectrum.data'), data: z.array(z.number()) }),
    z.object({
        type: z.literal('engine.status'),
        connected: z.boolean(),
        message: z.string().optional()
    }),
    z.object({
        type: z.literal('error'),
        code: z.string(),
        message: z.string()
    })
]);

function normalizeEngineEvent(raw) {
    const parsed = EngineRawEvent.safeParse(raw);
    if (!parsed.success) return null;
    const event = parsed.data;
    switch (event.type) {
        case 'playback_state':
            return { type: 'playback.state', state: event.state };
        case 'buffer_state':
            return {
                type: 'buffer.state',
                bufferedMs: event.buffered_ms,
                status: event.status,
                targetMs: event.target_ms
            };
        case 'stream_state':
            return {
                type: 'stream.state',
                status: event.status,
                error: event.error
            };
        case 'spectrum_data':
            return { type: 'spectrum.data', data: event.data };
        default:
            return null;
    }
}

module.exports = {
    EngineRawEvent,
    EngineEvent,
    normalizeEngineEvent
};
