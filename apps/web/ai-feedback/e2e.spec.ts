import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Catalog } from '../../../packages/shared/src/index';

const catalog = JSON.parse(readFileSync('content/catalog.json', 'utf8')) as Catalog;
const writingTasks = catalog.tasks.filter(task => task.kind === 'writing');
const privacyNotice = "Sends this essay, the task, the mentor text and the rubric to DeepSeek. DeepSeek (Hangzhou DeepSeek AI Co.) states that it processes and stores data in the People's Republic of China. Do not include names or student information.";

async function mockFeedback(page: Page, options: { available?: boolean; hosted?: boolean; attempts?: boolean; failRequest?: boolean } = {}) {
  const attempts = options.attempts === false ? [] : writingTasks.map(task => ({
    id: randomUUID(), taskId: task.id, taskVersion: task.version, submittedAt: '2026-11-09T17:00:00.000Z', hintCount: 0,
    originalAnswer: { parts: Object.fromEntries((task.parts ?? []).map(part => [part.id, 'A precise passage from my essay.'])) },
  }));
  const requests: unknown[] = [], approvals: unknown[] = [], external: string[] = [];
  const judgments: unknown[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.href); await route.abort(); return; }
    if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
    const body = route.request().method() === 'GET' ? undefined : route.request().postDataJSON() as Record<string, unknown>;
    let result: unknown = {};
    if (url.pathname === '/api/session') result = { csrfToken: 'test-session', ...(options.hosted ? { storageMode: 'postgres', authMode: 'public' } : {}) };
    else if (url.pathname === '/api/catalog') result = catalog;
    else if (url.pathname === '/api/state') result = { attempts, judgments, evidenceEvents: [], taskVersions: catalog.tasks };
    else if (url.pathname.startsWith('/api/drafts/')) {
      const task = writingTasks.find(item => item.id === decodeURIComponent(url.pathname.split('/').at(-1)!))!;
      result = { answer: null, taskVersion: task.version, currentTaskVersion: task.version, olderDrafts: [] };
    } else if (url.pathname === '/api/ai-feedback/status') result = {
      available: options.available ?? true, provider: 'DeepSeek', model: 'deepseek-flash', dailyBudgetUsd: 2,
      spentUsdToday: requests.length * 0.01, remainingRequestsToday: 60 - requests.length, privacyNotice,
    };
    else if (url.pathname === '/api/ai-feedback/preview') {
      const attempt = attempts.find(item => item.id === body!.attemptId)!;
      const task = writingTasks.find(item => item.id === attempt.taskId)!;
      const mentor = catalog.mentorTexts.find(item => item.id === task.mentorTextId)!;
      const rubric = catalog.rubrics.find(item => `${item.id}@${item.version}` === task.rubricVersionId)!;
      result = { available: true, model: 'deepseek-flash', previewSha256: 'a'.repeat(64), privacyNotice,
        sentData: { task: { title: task.title, prompt: task.prompt, parts: task.parts }, mentor: { title: mentor.title, text: mentor.text }, rubric: { criteria: rubric.criteria, scale: rubric.scale }, answer: attempt.originalAnswer.parts } };
    } else if (url.pathname === '/api/ai-feedback') {
      requests.push(body);
      if (options.failRequest) { await route.fulfill({ status: 502, json: { error: 'The AI response could not be validated; no feedback was saved. Use manual review.' } }); return; }
      const task = writingTasks.find(item => item.id === attempts.find(item => item.id === body!.attemptId)!.taskId)!;
      const rubric = catalog.rubrics.find(item => `${item.id}@${item.version}` === task.rubricVersionId)!;
      result = { requestId: randomUUID(), warning: 'Provisional AI draft. Not an official MTEL score. Review before saving.', proposal: {
        criteriaFeedback: rubric.criteria.map(criterion => ({ criterionId: criterion.id, comment: 'The instructional purpose is clear.', answerQuotes: ['A precise passage from my essay.'], missingEvidence: ['Explain how learning will be checked.'] })),
        holisticScore: 3, needsHumanReview: true, reason: 'A human should review the missing assessment rationale.',
      } };
    } else if (url.pathname === '/api/ai-feedback/approve') {
      approvals.push(body); result = { duplicate: approvals.length > 1 };
    }
    await route.fulfill({ status: 200, json: result });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Writing studio', exact: false }).click();
  return { attempts, requests, approvals, external };
}

test('AI controls require a preserved attempt and show a fallback when unavailable', async ({ page }) => {
  await mockFeedback(page, { attempts: false });
  await expect(page.getByRole('heading', { name: 'AI feedback (optional)' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Request AI feedback' })).toHaveCount(0);
});

test('unavailable local feedback points to the existing Grok handoff', async ({ page }) => {
  const service = await mockFeedback(page, { available: false });
  await expect(page.getByText(/AI feedback is not available/)).toBeVisible();
  await expect(page.getByText(/Exchange’s Grok handoff packet/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI feedback (optional)' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Request AI feedback' })).toHaveCount(0);
  expect(service.requests).toEqual([]);
});

test('preview and individual consent precede requests; unofficial feedback requires a separate save', async ({ page }) => {
  const service = await mockFeedback(page);
  await expect(page.getByText(privacyNotice, { exact: true })).toBeVisible();
  await expect(page.getByText(/Budget remaining today: \$2.00/)).toBeVisible();
  const request = page.getByRole('button', { name: 'Request AI feedback', exact: true });
  const consent = page.getByRole('checkbox', { name: /I reviewed the preview and consent/ });
  await expect(request).toBeDisabled();
  await expect(consent).not.toBeChecked();
  await page.getByRole('button', { name: 'Show exactly what will be sent' }).click();
  await expect(page.getByRole('heading', { name: 'Data to send to DeepSeek' })).toBeVisible();
  await expect(request).toBeDisabled();
  await consent.check();
  await expect(request).toBeEnabled();
  await request.click();
  await expect(page.getByRole('heading', { name: 'Provisional holistic score (unofficial): 3' })).toBeVisible();
  await expect(page.getByText('Needs human review: Yes', { exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Provisional AI feedback' }).getByText('A precise passage from my essay.', { exact: true }).first()).toBeVisible();
  await expect(consent).not.toBeChecked();
  await expect(request).toBeDisabled();
  expect(service.requests).toEqual([{ attemptId: service.attempts[0].id, previewSha256: 'a'.repeat(64), consent: true }]);
  expect(service.approvals).toEqual([]);
  await page.getByRole('button', { name: 'Save as provisional feedback' }).click();
  await expect(page.getByText('Provisional feedback saved. The original answer is unchanged.')).toBeVisible();
  expect(service.approvals).toHaveLength(1);
  expect(service.external).toEqual([]);
});

test('consent resets after a failed request and on task/attempt change', async ({ page }) => {
  await mockFeedback(page, { failRequest: true });
  const consent = page.getByRole('checkbox', { name: /I reviewed the preview and consent/ });
  await page.getByRole('button', { name: 'Show exactly what will be sent' }).click();
  await consent.check();
  await page.getByRole('button', { name: 'Request AI feedback' }).click();
  await expect(page.getByRole('alert')).toContainText('no feedback was saved');
  await expect(consent).not.toBeChecked();
  await consent.check();
  await page.getByLabel('Practice text and task').selectOption(writingTasks[1].id);
  await expect(consent).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Request AI feedback' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Data to send to DeepSeek' })).toHaveCount(0);
});

test('public hosted writing shows AI feedback while Exchange keeps manual handoff hidden', async ({ page }) => {
  await mockFeedback(page, { hosted: true });
  await expect(page.getByRole('heading', { name: 'AI feedback (optional)' })).toBeVisible();
  await expect(page.getByText(privacyNotice, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Take it with you', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Ask for another reading of your work' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Review a proposal before accepting it' })).toHaveCount(0);
});

test('unavailable hosted feedback recommends manual review', async ({ page }) => {
  await mockFeedback(page, { hosted: true, available: false });
  await expect(page.getByText('AI feedback is not available. Use manual review.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Exchange’s Grok handoff packet/)).toHaveCount(0);
});
