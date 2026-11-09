import {expect, test, type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {FlashcardSummary} from '../../../packages/shared/src/native-fsrs';
import type {Catalog, StudyState} from '../src/types';

const catalog = JSON.parse(readFileSync('content/catalog.json', 'utf8')) as Catalog;
const now = '2026-12-16T04:30:00.000Z'; // Still 15 December in Eastern Time.
const writingTask = catalog.tasks.find(task => task.id === 'task.writing.mentor.community-archive')!;

async function mockStudyDesk(page: Page, options: {state?: Partial<StudyState>; failFlashcards?: boolean} = {}) {
  const state: StudyState = {attempts: [], judgments: [], evidenceEvents: [], taskVersions: catalog.tasks, drafts: [], ...options.state};
  const controls = {
    failFlashcards: options.failFlashcards ?? false,
    summary: {initialized: true, total: catalog.cards.length, due: 10, new: catalog.cards.length, learning: 0, review: 0, held: 0} satisfies FlashcardSummary,
  };
  const requests: {method: string; path: string}[] = [], external: string[] = [];
  page.on('request', request => requests.push({method: request.method(), path: new URL(request.url()).pathname}));
  await page.clock.setFixedTime(new Date(now));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.href); await route.abort(); return; }
    if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
    if (request.method() !== 'GET') {
      await route.fulfill({status: 405, contentType: 'application/json', body: JSON.stringify({error: 'This fixture only permits reads.'})}); return;
    }
    let result: unknown;
    if (url.pathname === '/api/session') result = {csrfToken: 'synthetic-study-plan-token', storageMode: 'sqlite'};
    else if (url.pathname === '/api/catalog') result = catalog;
    else if (url.pathname === '/api/state') result = state;
    else if (url.pathname === '/api/native-flashcards') {
      if (controls.failFlashcards) {
        await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: 'Synthetic queue unavailable'})}); return;
      }
      result = {serverNow: now, reviewsSynchronized: false, queue: [], held: [], nextDue: null, summary: controls.summary};
    } else if (url.pathname.startsWith('/api/drafts/')) {
      const taskId = decodeURIComponent(url.pathname.split('/').at(-1)!), task = catalog.tasks.find(candidate => candidate.id === taskId)!;
      result = {answer: state.drafts?.find(draft => draft.taskId === taskId && String(draft.taskVersion) === String(task.version))?.answer ?? null,
        taskVersion: task.version, currentTaskVersion: task.version, olderDrafts: []};
    } else if (url.pathname === '/api/ai-feedback/status') result = {available: false, reason: 'Feedback is disabled in this browser fixture.'};
    else { await route.fulfill({status: 404, contentType: 'application/json', body: JSON.stringify({error: 'Unexpected fixture endpoint'})}); return; }
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(result)});
  });
  return {controls, requests, external};
}

test('desk exposes two accessible progress bars and a 40-minute plan without POSTs, then opens its essay task', async ({page}) => {
  const service = await mockStudyDesk(page);
  await page.goto('/');
  const plan = page.getByRole('region', {name: 'Your 40-minute plan', exact: true});
  await expect(plan.getByText(/About \d+ more 40-minute sessions?/)).toBeVisible();
  await expect(plan.getByText('32 days until 16 January 2027', {exact: true})).toBeVisible();
  await expect(plan.getByText(/Session 1 of about \d+/)).toBeVisible();
  await expect(plan.getByRole('progressbar')).toHaveCount(2);
  for (const name of ['Knowledge progress', 'Written-response progress']) {
    const bar = plan.getByRole('progressbar', {name, exact: true});
    await expect(bar).toHaveAttribute('aria-valuemin', '0');
    await expect(bar).toHaveAttribute('aria-valuemax', '100');
    await expect(bar).toHaveAttribute('aria-valuenow', /^\d+$/);
    const value = Number(await bar.getAttribute('aria-valuenow'));
    expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(100);
  }
  const slices = plan.getByRole('list', {name: 'Today:', exact: true}).getByRole('listitem');
  const minutes = await slices.evaluateAll(items => items.map(item => Number(item.getAttribute('data-minutes'))));
  expect(minutes.length).toBeGreaterThan(0); expect(minutes.length).toBeLessThanOrEqual(3);
  expect(minutes).toEqual([10, 15, 15]); expect(minutes.reduce((sum, value) => sum + value, 0)).toBe(40);
  expect(service.requests.filter(request => request.method === 'POST')).toEqual([]);
  await plan.getByRole('button', {name: 'Open essay practice', exact: true}).click();
  await expect(page.getByLabel('Practice text and task', {exact: true})).toHaveValue(writingTask.id);
  await expect(page.getByLabel(`Your response for ${writingTask.parts![0].title}`, {exact: true})).toBeEnabled();
  await expect(page.getByRole('navigation', {name: 'Writing parts'}).getByRole('button').first()).toHaveAttribute('aria-current', 'step');
  expect(service.requests.filter(request => request.method !== 'GET')).toEqual([]);
  expect(service.external).toEqual([]);
});

test('knowledge slice opens its named check with the objective lesson preselected', async ({page}) => {
  const service = await mockStudyDesk(page);
  await page.goto('/');
  const plan = page.getByRole('region', {name: 'Your 40-minute plan', exact: true});
  const knowledge = plan.locator('[data-track="knowledge"]');
  await expect(knowledge).toContainText('Objective 0001');
  const title = await knowledge.locator('p').innerText();
  expect(catalog.tasks.some(task => task.title === title && ['mc', 'short', 'case'].includes(task.kind))).toBe(true);
  await knowledge.getByRole('button', {name: 'Open knowledge practice', exact: true}).click();
  await expect(page.getByLabel('Short lesson', {exact: true})).toHaveValue('lesson.obj0001.identification-shared.v1');
  await expect(page.locator('.practice-card h2')).toHaveText(title);
  await expect(page.getByRole('button', {name: 'Save draft now', exact: true})).toBeEnabled();
  expect(service.requests.filter(request => request.method !== 'GET')).toEqual([]);
});

test('saved feedback prioritizes Part 2 and opens that writing part without preserving a new response', async ({page}) => {
  const part = writingTask.parts![1];
  const service = await mockStudyDesk(page, {state: {
    attempts: [{id: 'synthetic-writing-attempt', taskId: writingTask.id, taskVersion: writingTask.version,
      submittedAt: '2026-12-14T17:00:00.000Z', originalAnswer: {parts: {[part.id]: 'A synthetic first draft for feedback.'}}}],
    judgments: [{id: 'synthetic-feedback', attemptId: 'synthetic-writing-attempt', createdAt: '2026-12-14T18:00:00.000Z',
      result: {status: 'pending_review', provisional: true, sourceChecked: false}}],
  }});
  await page.goto('/');
  const plan = page.getByRole('region', {name: 'Your 40-minute plan', exact: true});
  await expect(plan.locator('[data-track="essay"]')).toContainText(/rewrite Part 2/);
  await plan.getByRole('button', {name: 'Open essay practice', exact: true}).click();
  await expect(page.getByLabel('Practice text and task', {exact: true})).toHaveValue(writingTask.id);
  await expect(page.getByLabel(`Your response for ${part.title}`, {exact: true})).toBeEnabled();
  await expect(page.getByRole('navigation', {name: 'Writing parts'}).getByRole('button').nth(1)).toHaveAttribute('aria-current', 'step');
  expect(service.requests.filter(request => request.method !== 'GET')).toEqual([]);
});

test('unavailable flashcard summary keeps maintenance time and the mobile plan usable', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  const service = await mockStudyDesk(page, {failFlashcards: true});
  await page.goto('/');
  const plan = page.getByRole('region', {name: 'Your 40-minute plan', exact: true});
  await expect(plan.getByText(/Flashcard workload is unknown/)).toBeVisible();
  await expect(plan.locator('[data-track="flashcards"]')).toHaveAttribute('data-minutes', '10');
  await plan.getByText('How this estimate works', {exact: true}).click();
  await expect(plan.getByText(/including 0 minutes of flashcard catch-up/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(service.requests.filter(request => request.method !== 'GET')).toEqual([]);
});

test('Refresh rereads both summaries using GET and reallocates a zero-due flashcard slice', async ({page}) => {
  const service = await mockStudyDesk(page);
  await page.goto('/');
  const plan = page.getByRole('region', {name: 'Your 40-minute plan', exact: true});
  const refresh = plan.getByRole('button', {name: 'Refresh', exact: true});
  await expect(plan.locator('[data-track="flashcards"]')).toBeVisible();
  await expect(refresh).toBeEnabled();
  const count = (path: string) => service.requests.filter(request => request.path === path).length;
  const stateReads = count('/api/state'), queueReads = count('/api/native-flashcards');
  service.controls.summary.due = 0;
  await refresh.click();
  await expect.poll(() => count('/api/state')).toBe(stateReads + 1);
  await expect.poll(() => count('/api/native-flashcards')).toBe(queueReads + 1);
  await expect(plan.locator('[data-track="flashcards"]')).toHaveCount(0);
  const minutes = await plan.getByRole('list', {name: 'Today:', exact: true}).getByRole('listitem')
    .evaluateAll(items => items.map(item => Number(item.getAttribute('data-minutes'))));
  expect(minutes).toHaveLength(2); expect(minutes.reduce((sum, value) => sum + value, 0)).toBe(40);
  expect(service.requests.filter(request => request.method !== 'GET')).toEqual([]);
});
