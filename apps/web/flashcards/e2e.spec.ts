import { expect, test, type Page } from '@playwright/test';
import type { NativeQueueResponse, NativeReceipt, NativeReviewInput } from '../../../packages/shared/src/native-fsrs';

const exactRecall = '  Espa\u00f1ol \ud83c\udf31\n\tkeep  spacing e\u0301  ';
async function openDeck(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Flashcards', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Recall, reveal, revisit.' })).toBeVisible();
}
async function start(page: Page) {
  await openDeck(page);
  await page.getByRole('button', { name: 'Review next card', exact: true }).click();
  await page.getByLabel('Optional typed recall', { exact: true }).fill(exactRecall);
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

test('mobile keyboard reveal preserves exact drafts across navigation/reload and saves recall without evidence', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await (await page.request.get('/api/state')).json();
  await start(page);
  const queue: NativeQueueResponse = await (await page.request.get('/api/native-flashcards')).json();
  const card = queue.queue[0].card;
  await expect(page.getByText(card.back, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Good', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Source library', exact: false }).click();
  await page.getByRole('button', { name: 'Flashcards', exact: false }).click();
  await expect(page.getByLabel('Optional typed recall', { exact: true })).toHaveValue(exactRecall);
  await page.reload();
  await page.getByRole('button', { name: 'Flashcards', exact: false }).click();
  await expect(page.getByLabel('Optional typed recall', { exact: true })).toHaveValue(exactRecall);
  await expect(page.getByLabel('I consulted materials or received help', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Reveal answer', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Answer revealed', exact: true })).toBeFocused();
  await expect(page.getByText(card.back, { exact: true })).toBeVisible();
  const writes: NativeReviewInput[] = [];
  page.on('request', request => { if (request.url().endsWith('/native-flashcards/reviews')) writes.push(request.postDataJSON() as NativeReviewInput); });
  await page.getByRole('button', { name: 'Good', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Self-reported recall saved. This review creates no learning evidence.', { exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: 'Reveal answer', exact: true }).click();
  await page.getByRole('button', { name: 'Easy', exact: true }).click();
  await expect(page.getByText('The receipt is unconfirmed. The exact pending request is retained; retry safely.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Flashcards', exact: false }).click();
  expect(await page.getByLabel('Pending response', { exact: true }).textContent()).toBe(exactRecall);
  await page.getByRole('button', { name: 'Retry original submission', exact: true }).click();
  await expect(page.getByText('Self-reported recall saved. This review creates no learning evidence.', { exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: 'Reveal answer', exact: true }).click();
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
  await expect(page.getByText('Self-reported recall saved. This review creates no learning evidence.', { exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: 'Reveal answer', exact: true }).click();
  await page.getByRole('button', { name: 'Again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Held submission', exact: true })).toBeVisible();
  expect(await page.getByLabel('Pending response', { exact: true }).textContent()).toBe(exactRecall);
  await page.getByRole('button', { name: 'Keep a recovery copy and close', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Browser recovery copies', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh due cards', exact: true }).click();
  await page.getByRole('button', { name: 'Review next card', exact: true }).click();
  await expect(page.getByLabel('Optional typed recall', { exact: true })).toHaveValue('');
});
