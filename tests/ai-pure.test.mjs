// Dependency-free checks: node --experimental-strip-types --test tests/ai-pure.test.mjs
// These tests read migration text. They never connect, execute SQL or call fetch.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEEPSEEK_BASE_URL, readAiConfig } from '../apps/server/src/ai/ai-config.ts';
import { dayEt, estimateCostMicroUsd, parseAiUsage, usageCostMicroUsd } from '../apps/server/src/ai/budget.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path => readFileSync(resolve(root, path), 'utf8');

test('configuration defaults are disabled without a key, with conservative peak prices', () => {
  const config = readAiConfig({});
  assert.equal(DEEPSEEK_BASE_URL, 'https://api.deepseek.com');
  assert.deepEqual(config, { apiKey: null, model: 'deepseek-flash', dailyBudgetUsd: 2,
    dailyBudgetMicroUsd: 2_000_000, dailyRequestCap: 60, priceInputMissPerM: 0.30,
    priceInputHitPerM: 0.006, priceOutputPerM: 1.20, maxOutputTokens: 1800 });
  assert.equal(readAiConfig({ DEEPSEEK_API_KEY: '   ' }).apiKey, null);
  assert.equal(readAiConfig({ AI_FEEDBACK_DAILY_BUDGET_USD: '0' }).dailyBudgetMicroUsd, 0);
  assert.equal(readAiConfig({ AI_FEEDBACK_DAILY_BUDGET_USD: '0.000001' }).dailyBudgetMicroUsd, 1);
  assert.equal(readAiConfig({ AI_FEEDBACK_DAILY_BUDGET_USD: '50' }).dailyBudgetMicroUsd, 50_000_000);
});

test('invalid configuration errors contain only the setting name', () => {
  for (const [setting, value] of [
    ['AI_FEEDBACK_MODEL', 'invalid-model-value'], ['AI_FEEDBACK_MODEL', 'deepseek-flash\n'],
    ['AI_FEEDBACK_DAILY_BUDGET_USD', '50.01'], ['AI_FEEDBACK_DAILY_BUDGET_USD', '-1'],
    ['AI_FEEDBACK_DAILY_REQUEST_CAP', '0'], ['AI_FEEDBACK_DAILY_REQUEST_CAP', '1001'],
    ['AI_FEEDBACK_DAILY_REQUEST_CAP', '1.5'], ['AI_FEEDBACK_PRICE_INPUT_MISS_PER_M', 'NaN'],
    ['AI_FEEDBACK_PRICE_INPUT_HIT_PER_M', '-0.01'], ['AI_FEEDBACK_PRICE_OUTPUT_PER_M', 'Infinity'],
    ['AI_FEEDBACK_MAX_OUTPUT_TOKENS', '0'], ['AI_FEEDBACK_MAX_OUTPUT_TOKENS', '1.1'],
  ]) assert.throws(() => readAiConfig({ [setting]: value }), { message: setting });
});

test('token costs are integer micro-USD with conservative rounding and usage validation', () => {
  const config = readAiConfig({});
  const usage = parseAiUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 900, completion_tokens: 200 });
  assert.deepEqual(usage, { promptTokens: 1000, cacheHitTokens: 100, cacheMissTokens: 900, completionTokens: 200 });
  assert.equal(usageCostMicroUsd(usage, config), 511);
  const messages = [{ role: 'system', content: 'Return json.' }, { role: 'user', content: 'Synthetic answer.' }];
  assert.equal(estimateCostMicroUsd(messages, config), Math.ceil(Math.ceil(JSON.stringify(messages).length / 3) * 0.3 + 1800 * 1.2));
  assert.deepEqual(parseAiUsage({ prompt_tokens: 20, completion_tokens: 10 }), { promptTokens: 20, cacheHitTokens: 0, cacheMissTokens: 20, completionTokens: 10 });
  for (const invalid of [null, {}, { prompt_tokens: -1, completion_tokens: 1 },
    { prompt_tokens: 20, completion_tokens: 10, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 0 }]) assert.equal(parseAiUsage(invalid), null);
});

test('New York midnight and daylight saving changes use the right calendar day', () => {
  for (const [instant, expected] of [
    ['2026-11-09T04:59:00Z', '2026-11-08'], ['2026-11-09T05:01:00Z', '2026-11-09'],
    ['2026-06-01T03:59:00Z', '2026-05-31'], ['2026-06-01T04:01:00Z', '2026-06-01'],
    ['2026-03-08T06:59:00Z', '2026-03-08'], ['2026-03-08T07:01:00Z', '2026-03-08'],
    ['2026-11-01T05:59:00Z', '2026-11-01'], ['2026-11-01T06:01:00Z', '2026-11-01'],
  ]) assert.equal(dayEt(new Date(instant)), expected);
});

test('migration text preserves operator ownership, forced owner RLS and minimal grants', () => {
  const previous = source('apps/server/src/postgres/migrations/002-sei-study.sql');
  const migration = source('apps/server/src/postgres/migrations/003-sei-ai-feedback.sql');
  const ownership = /DO \$ownership\$[\s\S]*?\$ownership\$;/;
  assert.equal(migration.match(ownership)?.[0], previous.match(ownership)?.[0]);
  assert.match(migration, /^-- OPERATOR ONLY\./);
  assert.match(migration, /\bBEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  for (const table of ['ai_feedback_usage', 'ai_feedback_requests']) assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS sei\\.${table} \\(`));
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /owner_id = sei\.request_owner_id\(\)/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE/);
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE/);
  assert.doesNotMatch(migration, /GRANT[^;]*(?:DELETE|TRUNCATE|ALL)/);
  assert.match(migration, /FOREIGN KEY \(owner_id, attempt_id\) REFERENCES sei\.attempts\(owner_id, id\)/);
  assert.doesNotMatch(migration, /(?:raw_model_output|essay_text|original_answer)\s+(?:text|jsonb)/i);
  assert.match(source('apps/server/postgres/harness.ts'), /migration\('003-sei-ai-feedback\.sql'\)/);
  assert.match(source('apps/server/src/store.ts'), /004-ai-feedback\.sql/);
});

test('client sources contain no provider environment setting names or key-shaped prefixes', () => {
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
  for (const path of walk(resolve(root, 'apps/web/src'))) assert.doesNotMatch(readFileSync(path, 'utf8'), /DEEPSEEK|\bsk-/);
});
