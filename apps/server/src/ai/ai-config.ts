/** Server-only configuration. Errors identify settings, never their supplied values. */
export type AiConfig = {
  apiKey: string | null;
  model: string;
  dailyBudgetUsd: number;
  dailyBudgetMicroUsd: number;
  dailyRequestCap: number;
  priceInputMissPerM: number;
  priceInputHitPerM: number;
  priceOutputPerM: number;
  maxOutputTokens: number;
};

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export function readAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const number = (name: string, fallback: number, min: number, max: number, integer = false) => {
    const value = env[name];
    if (value === undefined) return fallback;
    if (value.trim() !== value || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(name);
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) throw new Error(name);
    return parsed;
  };
  const model = env.AI_FEEDBACK_MODEL ?? 'deepseek-flash';
  // Leaves room for the server's fixed, unofficial judge label in ProposalSchema.
  if (model.trim() !== model || !/^deepseek-[a-z0-9.-]+$/.test(model) || model.length > 64) throw new Error('AI_FEEDBACK_MODEL');
  const dailyBudgetUsd = number('AI_FEEDBACK_DAILY_BUDGET_USD', 2, 0, 50);
  return {
    apiKey: env.DEEPSEEK_API_KEY?.trim() || null,
    model, dailyBudgetUsd, dailyBudgetMicroUsd: Math.floor(dailyBudgetUsd * 1_000_000),
    dailyRequestCap: number('AI_FEEDBACK_DAILY_REQUEST_CAP', 60, 1, 1000, true),
    priceInputMissPerM: number('AI_FEEDBACK_PRICE_INPUT_MISS_PER_M', 0.30, 0, 1_000_000),
    priceInputHitPerM: number('AI_FEEDBACK_PRICE_INPUT_HIT_PER_M', 0.006, 0, 1_000_000),
    priceOutputPerM: number('AI_FEEDBACK_PRICE_OUTPUT_PER_M', 1.20, 0, 1_000_000),
    maxOutputTokens: number('AI_FEEDBACK_MAX_OUTPUT_TOKENS', 1800, 1, 1_000_000, true),
  };
}
