import { DEEPSEEK_BASE_URL, type AiConfig } from './ai-config.js';
import { parseAiUsage, type AiUsage } from './budget.js';
import { AI_INVALID_RESPONSE, type AiMessage } from './feedback-request.js';

export type AiAdapterResult = { content: string; usage: AiUsage | null };
export type AiAdapter = { complete(messages: AiMessage[]): Promise<AiAdapterResult> };
export type AiAdapterOptions = { fetch?: typeof globalThis.fetch; clock?: () => Date };
export class AiAdapterError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly responseReceived = false,
    readonly usage: AiUsage | null = null,
    readonly kind: 'invalid' | 'provider' | 'unavailable' = 'provider',
  ) { super(message); this.name = 'AiAdapterError'; }
}

export class NullAdapter implements AiAdapter {
  async complete(_messages: AiMessage[]): Promise<AiAdapterResult> {
    throw new AiAdapterError(501, 'AI feedback is not available (no provider key configured). Use manual review', false, null, 'unavailable');
  }
}

export class DeepSeekAdapter implements AiAdapter {
  constructor(private readonly config: AiConfig, private readonly options: AiAdapterOptions = {}) {}

  async complete(messages: AiMessage[]): Promise<AiAdapterResult> {
    if (!this.config.apiKey) return new NullAdapter().complete(messages);
    const controller = new AbortController();
    const clock = this.options.clock ?? (() => new Date());
    const deadline = clock().getTime() + 50_000;
    let responseReceived = false, usage: AiUsage | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = () => new AiAdapterError(504, 'AI feedback timed out. Use manual review.', responseReceived, usage);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(timedOut()); }, 50_000);
    });
    const operation = async (): Promise<AiAdapterResult> => {
      const response = await (this.options.fetch ?? globalThis.fetch)(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.model, messages, response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: this.config.maxOutputTokens }),
      });
      responseReceived = true;
      if (clock().getTime() >= deadline) throw timedOut();
      if (!response.ok) {
        // Do not read provider error bodies; they may contain credentials or essay text.
        const failures: Record<number, [number, string]> = {
          401: [502, 'AI provider authentication failed. Use manual review.'],
          402: [502, 'AI provider credit is unavailable. Use manual review.'],
          429: [429, 'AI provider is temporarily rate limited. Use manual review.'],
        };
        const [status, message] = failures[response.status] ?? [502, 'AI provider is temporarily unavailable. Use manual review.'];
        throw new AiAdapterError(status, message, true);
      }
      let raw: unknown;
      try { raw = await response.json(); } catch { throw new AiAdapterError(502, AI_INVALID_RESPONSE, true, null, 'invalid'); }
      if (clock().getTime() >= deadline) throw timedOut();
      const envelope = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      usage = parseAiUsage(envelope.usage);
      const choices = envelope.choices;
      const first = Array.isArray(choices) && choices.length === 1 ? choices[0] as { finish_reason?: unknown; message?: { content?: unknown } } : undefined;
      const content = first?.message?.content;
      if (first?.finish_reason !== 'stop' || typeof content !== 'string' || !content.trim() || content.includes(this.config.apiKey!)) {
        throw new AiAdapterError(502, AI_INVALID_RESPONSE, true, usage, 'invalid');
      }
      // Decode before scanning so a key encoded with JSON unicode escapes cannot
      // become visible later when the server assembles the validated proposal.
      let modelJson: unknown;
      try { modelJson = JSON.parse(content); } catch { throw new AiAdapterError(502, AI_INVALID_RESPONSE, true, usage, 'invalid'); }
      const containsKey = (value: unknown): boolean => typeof value === 'string' ? value.includes(this.config.apiKey!) :
        Array.isArray(value) ? value.some(containsKey) : value !== null && typeof value === 'object' ?
          Object.entries(value).some(([key, item]) => containsKey(key) || containsKey(item)) : false;
      if (containsKey(modelJson)) throw new AiAdapterError(502, AI_INVALID_RESPONSE, true, usage, 'invalid');
      return { content, usage };
    };
    try { return await Promise.race([operation(), timeout]); }
    catch (error) {
      if (error instanceof AiAdapterError) throw error;
      // Never preserve cause or arbitrary fetch/JSON errors: they can include headers.
      if (controller.signal.aborted) throw timedOut();
      if (responseReceived) throw new AiAdapterError(502, AI_INVALID_RESPONSE, true, usage, 'invalid');
      throw new AiAdapterError(502, 'AI feedback could not reach the provider. Use manual review.', false, usage);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
}

export function createAiAdapter(config: AiConfig, options: AiAdapterOptions = {}): AiAdapter {
  return config.apiKey ? new DeepSeekAdapter(config, options) : new NullAdapter();
}
