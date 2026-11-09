import {randomBytes, randomUUID} from 'node:crypto';
import {expect, test} from '@playwright/test';

test.skip(!process.env.SEI_TEST_ADMIN_DATABASE_URL, 'A disposable Postgres cluster is required for hosted browser tests.');

test('password account opens the saved desk, signs out, signs in and closes registration', async ({page, context}) => {
  const username = `owner-${randomUUID().slice(0, 8)}`;
  const password = randomBytes(24).toString('base64url');
  await page.goto('/');
  await expect(page.getByRole('heading', {name: 'Sign in', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Create account', exact: true})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Your 40-minute plan'})).toHaveCount(0);
  await expect(page.getByRole('navigation', {name: 'Workspace'})).toHaveCount(0);
  expect((await context.request.get('/api/state')).status()).toBe(401);
  expect((await context.request.get('/api/native-flashcards')).status()).toBe(401);
  expect((await context.request.get('/api/ai-feedback/status')).status()).toBe(401);

  await page.getByRole('button', {name: 'Create account', exact: true}).click();
  await expect(page.getByText('The first account on this site keeps the study progress already saved here.')).toBeVisible();
  await expect(page.getByLabel('Username', {exact: true})).toBeFocused();
  await page.getByLabel('Username', {exact: true}).fill(username);
  await page.getByLabel('Password', {exact: true}).fill(password);
  await page.getByLabel('Confirm password', {exact: true}).fill(password);
  await page.getByRole('button', {name: 'Create account', exact: true}).click();
  await expect(page.getByText(`Signed in as ${username}`, {exact: true})).toBeVisible();
  const plan = page.getByRole('region', {name: 'Your 40-minute plan', exact: true});
  await expect(plan).toBeVisible();
  await expect(plan.getByRole('progressbar')).toHaveCount(2);
  await expect(page.getByText('Public hosted copy: anyone with this URL can read and write this study history.')).toHaveCount(0);
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Sign in', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Create account', exact: true})).toHaveCount(0);
  expect((await context.request.get('/api/state')).status()).toBe(401);

  await page.getByLabel('Username', {exact: true}).fill(username.toUpperCase());
  await page.getByLabel('Password', {exact: true}).fill(randomBytes(24).toString('base64url'));
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid username or password');
  await expect(page.getByRole('alert')).toBeFocused();
  await page.getByLabel('Password', {exact: true}).fill(password);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.getByText(`Signed in as ${username}`, {exact: true})).toBeVisible();
  await expect(plan.getByRole('progressbar')).toHaveCount(2);
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Sign in', exact: true})).toBeVisible();
  const session = await (await context.request.get('/api/session')).json() as {csrfToken: string};
  const closed = await context.request.post('/api/auth/signup', {
    headers: {origin: 'http://127.0.0.1:5176', 'x-csrf-token': session.csrfToken},
    data: {username: `other-${randomUUID().slice(0, 8)}`, password: randomBytes(24).toString('base64url')},
  });
  expect(closed.status()).toBe(403);

  // A mobile browser can reach account actions without the desktop sidebar footer.
  await page.setViewportSize({width: 390, height: 844});
  await page.getByLabel('Username', {exact: true}).fill(username);
  await page.getByLabel('Password', {exact: true}).fill(password);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Sign out', exact: true})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const refresh = plan.getByRole('button', {name: 'Refresh', exact: true});
  // Let the post-sign-in plan load settle so the expired-session request is the click below.
  await expect(refresh).toBeEnabled();
  await context.clearCookies();
  await refresh.click();
  await expect(page.getByRole('heading', {name: 'Sign in', exact: true})).toBeVisible();
  await expect(page.getByRole('navigation', {name: 'Workspace'})).toHaveCount(0);
});
