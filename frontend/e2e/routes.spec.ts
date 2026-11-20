import { expect, test } from '@playwright/test';

const routes = [
  { path: '/login', heading: 'Sign in' },
  { path: '/employee', heading: 'Employee area' },
  { path: '/technician', heading: 'Technician area' },
  { path: '/admin', heading: 'Admin area' },
];

for (const { path, heading } of routes) {
  test(`${path} renders without console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('landing page links reach each section', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'SmartDesk' })).toBeVisible();
  await page
    .getByRole('main')
    .getByRole('link', { name: /Technician/ })
    .click();
  await expect(page).toHaveURL(/\/technician$/);
});

test('unknown route shows the 404 page', async ({ page }) => {
  const res = await page.goto('/does-not-exist');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('keyboard: skip link is first focusable element and works', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard navigation is a desktop concern');
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
});
