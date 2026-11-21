import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, installMockApi, PASSWORD, type AccountKey } from './helpers/mockApi';

async function signIn(page: Page, key: AccountKey) {
  const account = ACCOUNTS[key];
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${account.portal}$`));
}

test('desktop shell exposes role navigation and active state', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop shell only');
  await installMockApi(page);
  await signIn(page, 'employee');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'My tickets' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await nav.getByRole('link', { name: 'New ticket' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New ticket' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'New ticket' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('mobile navigation opens, navigates, and restores focus', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile shell only');
  await installMockApi(page);
  await signIn(page, 'employee');
  const open = page.getByRole('button', { name: 'Open navigation' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Navigation' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await open.click();
  await dialog.getByRole('link', { name: 'New ticket' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New ticket' })).toBeVisible();
});

for (const route of ['/login', '/employee', '/technician', '/admin'] as const) {
  test(`${route} has no serious accessibility violations`, async ({ page }) => {
    await installMockApi(page);
    if (route === '/login') await page.goto(route);
    else await signIn(page, route.slice(1) as AccountKey);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? ''),
      ),
    ).toEqual([]);
  });
}

test('core surfaces match their visual baselines', async ({ page, isMobile }) => {
  test.skip(process.platform !== 'linux', 'Visual baselines use the Linux Playwright CI image');
  await installMockApi(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  const options = { animations: 'disabled', fullPage: true } as const;
  await expect(page).toHaveScreenshot('login.png', options);

  const readyText = {
    employee: 'You have not submitted any tickets yet.',
    technician: 'This queue is empty.',
  };
  for (const key of ['employee', 'technician', 'admin'] as const) {
    await signIn(page, key);
    if (key === 'admin') {
      await expect(page.getByRole('table', { name: 'User accounts' })).toBeVisible();
    } else {
      await expect(page.getByText(readyText[key], { exact: true })).toBeVisible();
    }
    await expect(page).toHaveScreenshot(`${key}-portal.png`, options);
    if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
  }
});
