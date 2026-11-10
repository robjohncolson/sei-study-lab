import { expect, test, type Page } from '@playwright/test';
import { NativeReviewSchema, type NativeQueueResponse, type NativeReceipt, type NativeReviewInput } from '../../../packages/shared/src/native-fsrs';

const exactRecall = '  Espa\u00f1ol \ud83c\udf31\n\tkeep  spacing e\u0301  ';
async function openDeck(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Flashcards', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Recall, check, revisit.' })).toBeVisible();
}
async function start(page: Page) {
  await openDeck(page);
  await page.getByRole('button', { name: 'Review next card', exact: true }).click();
  await page.getByLabel('Your recall', { exact: true }).fill(exactRecall);
  await page.getByLabel('I consulted materials or received help', { exact: true }).check();
  await page.getByRole('button', { name: 'Use a recall hint', exact: true }).click();
}
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => {
    const host = new URL(route.request().url()).hostname;
    return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort();
  });
});

test('lost initialization response retries on Reload and reopening preserves the same anchors', async ({ page }) => {
  const initialized: number[] = [];
  let anchors: NativeQueueResponse | undefined;
  await page.route('**/api/native-flashcards/initialize', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-csrf-token']).toBeTruthy();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    initialized.push((await response.json() as { initialized: number }).initialized);
    if (initialized.length === 1) {
      anchors = await (await page.request.get('/api/native-flashcards')).json() as NativeQueueResponse;
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  const before = await (await page.request.get('/api/state')).json();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Begin a practice check', exact: false })).toBeVisible();
  expect(initialized).toHaveLength(0);
  await page.getByRole('button', { name: 'Flashcards', exact: false }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review next card', exact: true })).toHaveCount(0);
  expect(initialized).toHaveLength(1);
  await page.getByRole('button', { name: 'Reload due cards', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review next card', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(initialized).toHaveLength(2);
  expect(initialized[1]).toBe(0);
  const retried: NativeQueueResponse = await (await page.request.get('/api/native-flashcards')).json();
  expect(retried.queue).toEqual(anchors!.queue);
  expect(retried.held).toEqual(anchors!.held);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Begin a practice check', exact: false })).toBeVisible();
  expect(initialized).toHaveLength(2);
  await page.getByRole('button', { name: 'Flashcards', exact: false }).click();
  await expect(page.getByRole('button', { name: 'Review next card', exact: true })).toBeVisible();
  expect(initialized).toHaveLength(3);
  expect(initialized[2]).toBe(0);
  const reopened: NativeQueueResponse = await (await page.request.get('/api/native-flashcards')).json();
  expect(reopened.queue).toEqual(anchors!.queue);
  expect(reopened.held).toEqual(anchors!.held);
  expect(await (await page.request.get('/api/state')).json()).toEqual(before);
});

test('mobile keyboard checking preserves exact drafts across navigation/reload and saves recall without evidence', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await (await page.request.get('/api/state')).json();
  await start(page);
  const queue: NativeQueueResponse = await (await page.request.get('/api/native-flashcards')).json();
  const card = queue.queue[0].card;
  await expect(page.getByText(card.back, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Good', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Source library', exact: false }).click();
  await page.getByRole('button', { name: 'Flashcards', exact: false }).click();
  await expect(page.getByLabel('Your recall', { exact: true })).toHaveValue(exactRecall);
  await page.reload();
  await page.getByRole('button', { name: 'Flashcards', exact: false }).click();
  await expect(page.getByLabel('Your recall', { exact: true })).toHaveValue(exactRecall);
  await expect(page.getByLabel('I consulted materials or received help', { exact: true })).toBeChecked();
  const checkButton = page.getByRole('button', { name: 'Check answer', exact: true });
  await expect(checkButton).toBeEnabled();
  await checkButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Answer checked', exact: true })).toBeFocused();
  await expect(page.getByText(card.back, { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Choose a rating', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const writes: NativeReviewInput[] = [];
  page.on('request', request => { if (request.url().endsWith('/native-flashcards/reviews')) writes.push(request.postDataJSON() as NativeReviewInput); });
  await page.getByRole('button', { name: 'Good', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Review saved. This schedules the card only; it creates no learning evidence.', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ response: exactRecall, hintCount: 1, assistance: ['consulted_materials', 'study_hint'], revealed: true, rating: 3 });
  await expect(page.getByText(/^UTC schedule:/)).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Flashcards', exact: false }).click();
  const afterQueue: NativeQueueResponse = await (await page.request.get('/api/native-flashcards')).json();
  expect(afterQueue.queue.some(item => item.card.id === card.id)).toBe(false);
  expect(await (await page.request.get('/api/state')).json()).toEqual(before);
});

test('accepted review with a lost response retries the original frozen request after reload', async ({ page }) => {
  const writes: NativeReviewInput[] = [];
  let receipt: NativeReceipt | undefined;
  await page.route('**/api/native-flashcards/reviews', async route => {
    writes.push(route.request().postDataJSON() as NativeReviewInput);
    if (writes.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      receipt = await response.json() as NativeReceipt;
      await route.abort('failed');
    } else await route.continue();
  });
  await start(page);
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await page.getByRole('button', { name: 'Easy', exact: true }).click();
  await expect(page.getByText('The receipt is unconfirmed. The exact pending request is retained; retry safely.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Flashcards', exact: false }).click();
  expect(await page.getByLabel('Pending response', { exact: true }).textContent()).toBe(exactRecall);
  await page.getByRole('button', { name: 'Retry original submission', exact: true }).click();
  await expect(page.getByText('Review saved. This schedules the card only; it creates no learning evidence.', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  await expect(page.getByText(`Receipt: ${receipt!.eventId}`, { exact: false })).toBeVisible();
});

test('delayed failed submission survives immediate navigation and retains assistance on retry', async ({ page }) => {
  let frozen: NativeReviewInput | undefined;
  let releaseResponse: () => void = () => { throw new Error('Response gate was not initialized'); };
  const delayedResponse = new Promise<void>(resolve => { releaseResponse = resolve; });
  await page.route('**/api/native-flashcards/reviews', async route => {
    frozen = route.request().postDataJSON() as NativeReviewInput;
    await delayedResponse;
    await route.abort('failed');
  });
  await start(page);
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  const firstWrite = page.waitForRequest(request => request.url().endsWith('/native-flashcards/reviews'));
  await page.getByRole('button', { name: 'Hard', exact: true }).click();
  await firstWrite;
  await page.getByRole('button', { name: 'Source library', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Know what supports the content.' })).toBeVisible();
  const failure = page.waitForEvent('requestfailed', request => request.url().endsWith('/native-flashcards/reviews'));
  releaseResponse();
  await failure;
  await page.reload();
  await page.getByRole('button', { name: 'Flashcards', exact: false }).click();
  expect(await page.getByLabel('Pending response', { exact: true }).textContent()).toBe(exactRecall);
  await expect(page.getByText('Recall rating: Hard', { exact: true })).toBeVisible();
  await page.unroute('**/api/native-flashcards/reviews');
  const retried = page.waitForRequest(request => request.url().endsWith('/native-flashcards/reviews'));
  await page.getByRole('button', { name: 'Retry original submission', exact: true }).click();
  expect((await retried).postDataJSON()).toEqual(frozen);
  await expect(page.getByText('Review saved. This schedules the card only; it creates no learning evidence.', { exact: true })).toBeVisible();
});

test('a stale rating is visibly held and recovery never copies it onto the next card', async ({ page }) => {
  await start(page);
  const queue: NativeQueueResponse = await (await page.request.get('/api/native-flashcards')).json();
  const first = queue.queue[0];
  const { csrfToken } = await (await page.request.get('/api/session')).json() as { csrfToken: string };
  const control = await page.request.post('/api/native-flashcards/controls', {
    headers: { origin: 'http://127.0.0.1:5174', 'x-csrf-token': csrfToken },
    data: { clientEventId: crypto.randomUUID(), cardId: first.card.id, cardFingerprint: first.cardFingerprint,
      expectedVersion: first.version, clientNow: new Date().toISOString(), action: 'keep' },
  });
  expect(control.status()).toBe(200);
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await page.getByRole('button', { name: 'Again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Held submission', exact: true })).toBeVisible();
  expect(await page.getByLabel('Pending response', { exact: true }).textContent()).toBe(exactRecall);
  await page.getByRole('button', { name: 'Keep a recovery copy and close', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Browser recovery copies', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh due cards', exact: true }).click();
  await page.getByRole('button', { name: 'Review next card', exact: true }).click();
  await expect(page.getByLabel('Your recall', { exact: true })).toHaveValue('');
});

const cardPrivacyNotice = "Sends this card's prompt, its target answer and your typed recall to DeepSeek. DeepSeek (Hangzhou DeepSeek AI Co.) states that it processes and stores data in the People's Republic of China. Do not include names or student information.";
type PreviewInput = { cardId: string; cardFingerprint: string; response: string };
type CheckInput = PreviewInput & { previewSha256: string; consent: true };

async function mockCardCheck(page: Page, options: { closeness?: 'correct' | 'close' | 'incorrect'; fail?: boolean } = {}) {
  const previews: PreviewInput[] = [], checks: CheckInput[] = [];
  await page.route('**/api/flashcard-grade/status', route => route.fulfill({ json: {
    available: true, model: 'deepseek-flash', privacyNotice: cardPrivacyNotice, remainingFlashcardRequestsToday: 50,
  } }));
  await page.route('**/api/flashcard-grade/preview', async route => {
    const body = route.request().postDataJSON() as PreviewInput;
    previews.push(body);
    const queue = await (await page.request.get('/api/native-flashcards')).json() as NativeQueueResponse;
    const item = [...queue.queue, ...queue.held].find(candidate => candidate.card.id === body.cardId)!;
    expect(item.cardFingerprint).toBe(body.cardFingerprint);
    await route.fulfill({ json: { available: true, model: 'deepseek-flash', previewSha256: 'a'.repeat(64),
      sentData: { front: item.card.front, back: item.card.back, response: body.response }, privacyNotice: cardPrivacyNotice } });
  });
  await page.route('**/api/flashcard-grade', async route => {
    checks.push(route.request().postDataJSON() as CheckInput);
    expect(route.request().headers()['x-csrf-token']).toBeTruthy();
    if (options.fail) {
      await route.fulfill({ status: 429, json: { error: 'Daily AI grading limit reached. Choose a rating yourself.' } });
    } else await route.fulfill({ json: { closeness: options.closeness ?? 'close', source: 'ai',
      explanation: 'You recalled the main idea; include the named concept.',
      warning: 'Unofficial AI closeness check. It is not an MTEL score and does not count as evidence.' } });
  });
  return { previews, checks };
}

async function startCheck(page: Page, response: string, consent = true) {
  await openDeck(page);
  const checkbox = page.getByRole('checkbox', { name: 'Use AI checking for this session', exact: true });
  await expect(checkbox).not.toBeChecked();
  if (consent) await checkbox.check();
  await page.getByRole('button', { name: 'Review next card', exact: true }).click();
  const queue = await (await page.request.get('/api/native-flashcards')).json() as NativeQueueResponse;
  await page.getByLabel('Your recall', { exact: true }).fill(response);
  return queue.queue[0];
}

test('AI closeness freezes the timer and recall; Continue saves only the strict review fields', async ({ page }) => {
  const service = await mockCardCheck(page);
  const response = '  My recalled idea, in my own words.\nKeep this spacing.  ';
  const item = await startCheck(page, response);
  await expect(page.getByText(/^Time: \d+\.\d s$/)).toBeVisible();
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Answer checked', exact: true })).toBeFocused();
  await expect(page.getByText('Close — unofficial AI check', { exact: true })).toBeVisible();
  const elapsed = page.getByText(/^You answered in /);
  await expect(elapsed).toBeVisible();
  const frozenTime = await elapsed.textContent();
  await expect(page.getByText(item.card.back, { exact: true })).toBeVisible();
  expect(await page.getByLabel('Frozen recall', { exact: true }).textContent()).toBe(response);
  await expect(page.getByText('Rating to save: Hard', { exact: true })).toBeVisible();
  expect(service.previews).toEqual([{ cardId: item.card.id, cardFingerprint: item.cardFingerprint, response }]);
  expect(service.checks).toEqual([{ cardId: item.card.id, cardFingerprint: item.cardFingerprint, response,
    previewSha256: 'a'.repeat(64), consent: true }]);
  // Reload retains the result and consent without paying for another check.
  await page.reload();
  await page.getByRole('button', { name: 'Flashcards', exact: false }).click();
  await expect(page.getByRole('checkbox', { name: 'Use AI checking for this session', exact: true })).toBeChecked();
  await expect(page.getByText('Rating to save: Hard', { exact: true })).toBeVisible();
  await expect(elapsed).toHaveText(frozenTime!);
  expect(service.previews).toHaveLength(1);
  expect(service.checks).toHaveLength(1);
  const write = page.waitForRequest(request => request.url().endsWith('/native-flashcards/reviews'));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const body: unknown = (await write).postDataJSON();
  expect(NativeReviewSchema.parse(body)).toMatchObject({ cardId: item.card.id, response, rating: 2,
    assistance: [], hintCount: 0, revealed: true });
  expect(Object.keys(body as Record<string, unknown>).sort()).toEqual([
    'assistance', 'cardFingerprint', 'cardId', 'clientEventId', 'clientNow', 'expectedVersion', 'hintCount',
    'rating', 'response', 'revealed', 'revealedAt', 'startedAt',
  ].sort());
  await expect(page.getByText('Review saved. This schedules the card only; it creates no learning evidence.', { exact: true })).toBeVisible();
});

test('Change rating allows a manual override of an AI suggestion', async ({ page }) => {
  await mockCardCheck(page);
  await startCheck(page, 'An incomplete recollection of the idea.');
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await expect(page.getByText('Rating to save: Hard', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Good', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Change rating', exact: true }).click();
  const write = page.waitForRequest(request => request.url().endsWith('/native-flashcards/reviews'));
  await page.getByRole('button', { name: 'Good', exact: true }).click();
  expect(NativeReviewSchema.parse((await write).postDataJSON()).rating).toBe(3);
  await expect(page.getByText('Review saved. This schedules the card only; it creates no learning evidence.', { exact: true })).toBeVisible();
});

test('blank recall suggests Again without a preview or AI request', async ({ page }) => {
  const service = await mockCardCheck(page);
  await startCheck(page, ' \n\t ');
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await expect(page.getByText('No recall entered', { exact: true })).toBeVisible();
  await expect(page.getByText('Rating to save: Again', { exact: true })).toBeVisible();
  await expect(page.getByText(/^You answered in /)).toBeVisible();
  expect(service.previews).toEqual([]);
  expect(service.checks).toEqual([]);
});

test('I do not know preserves any typed recall and suggests Again without AI', async ({ page }) => {
  const service = await mockCardCheck(page);
  const response = 'A fragment I cannot finish.';
  await startCheck(page, response);
  await page.getByRole('button', { name: "I don't know", exact: true }).click();
  await expect(page.getByText('Rating to save: Again', { exact: true })).toBeVisible();
  expect(await page.getByLabel('Frozen recall', { exact: true }).textContent()).toBe(response);
  expect(service.previews).toEqual([]);
  expect(service.checks).toEqual([]);
});

test('an exact target match skips preview and AI calls', async ({ page }) => {
  const service = await mockCardCheck(page);
  const item = await startCheck(page, '');
  await page.getByLabel('Your recall', { exact: true }).fill(item.card.back);
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await expect(page.getByText('Correct (exact match)', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Rating to save: /)).toBeVisible();
  expect(service.previews).toEqual([]);
  expect(service.checks).toEqual([]);
});

test('the daily AI limit leaves the frozen timer, target and four fallback ratings', async ({ page }) => {
  const service = await mockCardCheck(page, { fail: true });
  const item = await startCheck(page, 'Some recalled subject matter.');
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await expect(page.getByText('Daily AI grading limit reached. Choose a rating yourself.', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('group', { name: 'Choose a rating', exact: true })).toBeVisible();
  for (const name of ['Again', 'Hard', 'Good', 'Easy']) await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
  await expect(page.getByText(/^You answered in /)).toBeVisible();
  await expect(page.getByText(item.card.back, { exact: true })).toBeVisible();
  expect(service.checks).toHaveLength(1);
});

test('consent off uses manual ratings and sends no preview or grade', async ({ page }) => {
  const service = await mockCardCheck(page);
  await startCheck(page, 'A non-exact recollection.', false);
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await expect(page.getByText('AI checking is off; choose a rating.', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Choose a rating', exact: true })).toBeVisible();
  expect(service.previews).toEqual([]);
  expect(service.checks).toEqual([]);
});

test('the disclosure shows the exact three fields without requesting a grade', async ({ page }) => {
  const service = await mockCardCheck(page);
  const response = '  My words\nwith exact spacing.  ';
  const item = await startCheck(page, response, false);
  await page.getByText('Show exactly what will be sent', { exact: true }).click();
  await expect(page.getByLabel('Preview prompt', { exact: true })).toBeVisible();
  expect(await page.getByLabel('Preview prompt', { exact: true }).textContent()).toBe(item.card.front);
  expect(await page.getByLabel('Preview target answer', { exact: true }).textContent()).toBe(item.card.back);
  expect(await page.getByLabel('Preview recall', { exact: true }).textContent()).toBe(response);
  await expect(page.getByText(cardPrivacyNotice, { exact: true }).last()).toBeVisible();
  expect(service.previews).toEqual([{ cardId: item.card.id, cardFingerprint: item.cardFingerprint, response }]);
  expect(service.checks).toEqual([]);
  await expect(page.getByRole('button', { name: 'Check answer', exact: true })).toBeVisible();
});

test('a correct fast recall with consulted materials is capped at Hard', async ({ page }) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const service = await mockCardCheck(page, { closeness: 'correct' });
  await startCheck(page, 'The correct idea expressed in different words.');
  await page.getByLabel('I consulted materials or received help', { exact: true }).check();
  await page.clock.runFor(1000);
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await expect(page.getByText('Correct — unofficial AI check', { exact: true })).toBeVisible();
  await expect(page.getByText('Rating to save: Hard', { exact: true })).toBeVisible();
  await expect(page.getByText(/help or hints used, capped at Hard/i)).toBeVisible();
  expect(service.checks).toHaveLength(1);
  expect(Object.keys(service.checks[0]).sort()).toEqual(['cardId', 'cardFingerprint', 'response', 'previewSha256', 'consent'].sort());
});

test('a slow AI request times out to manual ratings and ignores a late response', async ({ page }) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await mockCardCheck(page);
  let finish: () => void = () => { throw new Error('The delayed response was not initialized'); };
  const delayed = new Promise<void>(resolve => { finish = resolve; });
  let delivered: () => void = () => { throw new Error('The delivery gate was not initialized'); };
  const delivery = new Promise<void>(resolve => { delivered = resolve; });
  await page.route('**/api/flashcard-grade', async route => {
    await delayed;
    await route.fulfill({ json: { closeness: 'correct', source: 'ai', explanation: 'Your recall matches the idea.' } });
    delivered();
  });
  const item = await startCheck(page, 'A recall awaiting the checker.');
  const checking = page.waitForRequest(request => new URL(request.url()).pathname === '/api/flashcard-grade');
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await checking;
  await expect(page.getByText('Checking with DeepSeek…', { exact: true })).toBeVisible();
  const elapsed = page.getByText(/^You answered in /);
  const frozenTime = await elapsed.textContent();
  await page.clock.runFor(55_001);
  await expect(page.getByRole('alert')).toHaveText('The AI check timed out. Choose a rating yourself.');
  await expect(page.getByRole('group', { name: 'Choose a rating', exact: true })).toBeVisible();
  await expect(elapsed).toHaveText(frozenTime!);
  await expect(page.getByText(item.card.back, { exact: true })).toBeVisible();
  const responseFinished = page.waitForEvent('requestfinished', request => new URL(request.url()).pathname === '/api/flashcard-grade');
  finish();
  await delivery;
  await responseFinished;
  await page.clock.runFor(100);
  await expect(page.getByRole('alert')).toHaveText('The AI check timed out. Choose a rating yourself.');
  for (const name of ['Again', 'Hard', 'Good', 'Easy']) await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
  await expect(page.getByText('Correct — unofficial AI check', { exact: true })).toHaveCount(0);
});

test('a revealed version-one draft without a check recovers into manual ratings without AI', async ({ page }) => {
  const service = await mockCardCheck(page);
  const response = 'Recall preserved by an earlier version.';
  await startCheck(page, response);
  await page.evaluate(() => {
    const key = 'sei.native-flashcards.draft.v1';
    const saved = JSON.parse(localStorage.getItem(key)!) as { schemaVersion: number; active: { revealedAt: string | null; check?: unknown } };
    saved.active.revealedAt = new Date().toISOString();
    delete saved.active.check;
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Flashcards', exact: false }).click();
  await expect(page.getByRole('checkbox', { name: 'Use AI checking for this session', exact: true })).toBeChecked();
  await expect(page.getByRole('group', { name: 'Choose a rating', exact: true })).toBeVisible();
  await expect(page.getByText(/^You answered in /)).toBeVisible();
  expect(await page.getByLabel('Frozen recall', { exact: true }).textContent()).toBe(response);
  expect(service.previews).toEqual([]);
  expect(service.checks).toEqual([]);
});
