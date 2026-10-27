import { Usage, type Model } from '@openai/agents';

export type ScriptStep =
  | { text: string; id?: string }
  | {
      call: {
        name: string;
        arguments?: Record<string, unknown>;
        callId?: string;
      };
    };

// A model that plays a script, one step per model call, streaming raw Responses events
// for text the way the real API does. Steps after the end repeat the last one.
export function scriptedModel(steps: ScriptStep[]): Model & { calls: number } {
  const model = {
    calls: 0,
    output(step: ScriptStep) {
      if ('call' in step)
        return [
          {
            type: 'function_call' as const,
            id: `fc_${model.calls}`,
            callId: step.call.callId ?? `call_${model.calls}`,
            name: step.call.name,
            arguments: JSON.stringify(step.call.arguments ?? {}),
          },
        ];
      return [
        {
          type: 'message' as const,
          id: step.id ?? `msg_${model.calls}`,
          role: 'assistant' as const,
          status: 'completed' as const,
          content: [{ type: 'output_text' as const, text: step.text }],
        },
      ];
    },
    next() {
      const step = steps[Math.min(model.calls, steps.length - 1)];
      model.calls += 1;
      return step;
    },
    async getResponse() {
      return { usage: new Usage(), output: model.output(model.next()) };
    },
    async *getStreamedResponse() {
      const step = model.next();
      const output = model.output(step);
      yield { type: 'response_started' as const };
      if ('text' in step) {
        const message = output[0] as { id: string };
        const raw = (event: Record<string, unknown>) =>
          ({ type: 'model' as const, event }) as never;
        yield raw({
          type: 'response.output_item.added',
          item: { ...output[0], content: [] },
        });
        yield raw({
          type: 'response.content_part.added',
          item_id: message.id,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
        yield raw({
          type: 'response.output_text.delta',
          item_id: message.id,
          content_index: 0,
          delta: step.text,
        });
        yield raw({
          type: 'response.output_text.done',
          item_id: message.id,
          content_index: 0,
          text: step.text,
        });
        yield raw({ type: 'response.output_item.done', item: output[0] });
      }
      yield {
        type: 'response_done' as const,
        response: { id: `resp_${model.calls}`, usage: new Usage(), output },
      } as never;
    },
  };
  return model as unknown as Model & { calls: number };
}
