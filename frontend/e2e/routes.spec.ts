import { expect, test } from '@playwright/test';
import { ACCOUNTS, installMockApi, PASSWORD } from './helpers/mockApi';

// The browser logs a failed fetch (the expected 401 from an anonymous session restore) as a
// console error; that is not an application error.
const isNetworkNoise = (text: string) => /Failed to load resource/.test(text);

function collectErrors(page: import('@playwright/test').Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on(
    'console',
    (m) => m.type() === 'error' && !isNetworkNoise(m.text()) && errors.push(m.text()),
  );
  return errors;
}

test('/login renders without console errors', async ({ page }) => {
  await installMockApi(page);
  const errors = collectErrors(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const key of ['employee', 'technician', 'admin'] as const) {
  const a = ACCOUNTS[key];
  test(`${a.portal} renders for its role without console errors`, async ({ page }) => {
    await installMockApi(page);
    const errors = collectErrors(page);
    await page.goto('/login');
    await page.getByLabel('Email').fill(a.email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: a.heading })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('root sends anonymous visitors to the sign-in workspace', async ({ page }) => {
  await installMockApi(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
});

test('unknown route shows the 404 page', async ({ page }) => {
  const res = await page.goto('/does-not-exist');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('keyboard: skip link is first focusable element and works', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard navigation is a desktop concern');
  await page.goto('/login');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
});
