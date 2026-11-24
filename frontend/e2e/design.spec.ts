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
  await expect(dialog.getByRole('button', { name: 'Close navigation' })).toBeFocused();
  await page.locator('#main input[name="q"]').evaluate((input) => (input as HTMLElement).focus());
  await expect(dialog.getByRole('button', { name: 'Close navigation' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await open.click();
  await dialog.getByRole('link', { name: 'New ticket' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New ticket' })).toBeVisible();
});

test('theme follows the device and keeps an explicit choice across reloads', async ({ page }) => {
  await installMockApi(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/login');
  const theme = page.getByRole('combobox', { name: 'Theme' });
  await expect(theme).toHaveValue('system');
  const body = page.locator('body');
  const darkCanvas = await body.evaluate((el) => getComputedStyle(el).backgroundColor);

  await page.emulateMedia({ colorScheme: 'light' });
  await expect(body).not.toHaveCSS('background-color', darkCanvas);
  await theme.selectOption('dark');
  await expect(body).toHaveCSS('background-color', darkCanvas);
  await page.reload();
  await expect(theme).toHaveValue('dark');
  await expect(body).toHaveCSS('background-color', darkCanvas);

  await page.emulateMedia({ colorScheme: 'dark' });
  await theme.selectOption('light');
  await expect(body).not.toHaveCSS('background-color', darkCanvas);
  await theme.selectOption('system');
  await expect(body).toHaveCSS('background-color', darkCanvas);
});

test('theme can change while a ticket draft is open', async ({ page, isMobile }) => {
  await installMockApi(page);
  await signIn(page, 'employee');
  await page.goto('/employee/tickets/new');
  const title = page.getByLabel('Title');
  await title.fill('Keep this title when switching themes');
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('combobox', { name: 'Theme' }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  if (isMobile) await page.getByRole('button', { name: 'Close navigation' }).click();
  await expect(title).toHaveValue('Keep this title when switching themes');
});

test('theme works for the current page when storage is unavailable', async ({ page }) => {
  await installMockApi(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage unavailable', 'SecurityError');
      },
    });
  });
  await page.goto('/login');
  const theme = page.getByRole('combobox', { name: 'Theme' });
  await expect(theme).toHaveValue('system');
  await theme.selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(theme).toHaveValue('system');
});

test('queue tabs are operable by keyboard', async ({ page }) => {
  await installMockApi(page);
  await signIn(page, 'technician');
  const unassigned = page.getByRole('tab', { name: 'Unassigned' });
  await unassigned.focus();
  await unassigned.press('ArrowRight');
  const team = page.getByRole('tab', { name: 'Team queue' });
  await expect(team).toBeFocused();
  await expect(team).toHaveAttribute('aria-selected', 'true');
  await team.press('End');
  await expect(page.getByRole('tabpanel', { name: 'Assigned to me' })).toBeVisible();
});

test('long ticket titles fit in the list and triage view', async ({ page }) => {
  const api = await installMockApi(page);
  const [ticket] = api.seedTickets(1);
  const title = 'A'.repeat(120);
  ticket!.title = title;
  await page.setViewportSize({ width: 320, height: 800 });
  await signIn(page, 'technician');
  const link = page.getByRole('link', { name: title });
  await expect(link).toBeVisible();
  expect((await link.boundingBox())!.width).toBeLessThan(320);
  await link.click();
  const heading = page.getByRole('heading', { name: title });
  await expect(heading).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('forced colors retain active navigation and visible keyboard focus', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'desktop navigation');
  await installMockApi(page);
  await page.emulateMedia({ forcedColors: 'active' });
  await signIn(page, 'employee');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const active = nav.getByRole('link', { name: 'My tickets' });
  await expect(active).toHaveAttribute('aria-current', 'page');
  await expect(active).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await page.keyboard.press('Tab');
  await nav.getByRole('link', { name: 'New ticket' }).focus();
  await expect(nav.getByRole('link', { name: 'New ticket' })).toHaveCSS('outline-style', 'solid');
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

for (const key of ['employee', 'technician', 'admin'] as const) {
  test(`${key} portal fits the viewport and exposes sign-out`, async ({ page, isMobile }) => {
    await installMockApi(page);
    await signIn(page, key);
    if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    if (isMobile) await page.keyboard.press('Escape');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test.describe('visual baselines', () => {
  test.use({ timezoneId: 'UTC' });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`core surfaces in ${colorScheme} mode`, async ({ page, isMobile }) => {
      test.skip(process.platform !== 'linux', 'Visual baselines use the Linux Playwright CI image');
      await page.emulateMedia({ colorScheme });
      const api = await installMockApi(page);
      const [vpn, access, laptop, display] = api.seedTickets(4);
      Object.assign(vpn!, { title: 'VPN disconnects after sign-in', priority: 'CRITICAL' });
      Object.assign(access!, { title: 'Cannot access the finance share', priority: 'HIGH' });
      Object.assign(laptop!, {
        title: 'Enroll a new laptop',
        status: 'IN_PROGRESS',
        priority: 'MEDIUM',
      });
      Object.assign(display!, { title: 'Meeting room display shows a blank screen' });

      const suffix = colorScheme === 'dark' ? '-dark' : '';
      const options = { animations: 'disabled', fullPage: true } as const;
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
      await expect(page).toHaveScreenshot(`login${suffix}.png`, options);

      const captions = {
        employee: 'Your tickets, newest first',
        technician: 'Unassigned, most urgent first',
        admin: 'User accounts',
      };
      for (const key of ['employee', 'technician', 'admin'] as const) {
        await signIn(page, key);
        await expect(page.getByRole('table', { name: captions[key] })).toBeVisible();
        await page.mouse.move(0, 0);
        await expect(page).toHaveScreenshot(`${key}-portal${suffix}.png`, options);
        if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
        await page.getByRole('button', { name: 'Sign out' }).click();
        await expect(page).toHaveURL(/\/login$/);
      }
    });
  }
});
