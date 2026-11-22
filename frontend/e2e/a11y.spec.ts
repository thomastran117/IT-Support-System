import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, installMockApi, PASSWORD, type AccountKey } from './helpers/mockApi';

/**
 * Accessibility and responsive checks over every screen: automated WCAG 2.2 AA rules (axe),
 * no horizontal overflow from 320 px up, and keyboard-only critical journeys. The `desktop` and
 * `mobile` projects run each check at their own viewport; the width sweep adds 320/375/768.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function signIn(page: Page, key: AccountKey) {
  const account = ACCOUNTS[key];
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${account.portal}$`));
}

async function settle(page: Page) {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.getByRole('status', { name: /^Loading/ })).toHaveCount(0);
  await page.waitForLoadState('networkidle');
}

interface Screen {
  name: string;
  as: AccountKey | null;
  path: (ids: { ticket: string; article: string }) => string;
}

const SCREENS: Screen[] = [
  { name: 'login', as: null, path: () => '/login' },
  { name: 'employee tickets', as: 'employee', path: () => '/employee' },
  { name: 'employee new ticket', as: 'employee', path: () => '/employee/tickets/new' },
  { name: 'employee ticket detail', as: 'employee', path: (i) => `/employee/tickets/${i.ticket}` },
  { name: 'employee knowledge search', as: 'employee', path: () => '/employee/knowledge' },
  { name: 'employee article', as: 'employee', path: (i) => `/employee/knowledge/${i.article}` },
  { name: 'technician queue', as: 'technician', path: () => '/technician' },
  { name: 'technician triage', as: 'technician', path: (i) => `/technician/tickets/${i.ticket}` },
  { name: 'technician knowledge', as: 'technician', path: () => '/technician/knowledge' },
  { name: 'admin users', as: 'admin', path: () => '/admin' },
  { name: 'admin categories', as: 'admin', path: () => '/admin/categories' },
  { name: 'admin teams', as: 'admin', path: () => '/admin/teams' },
  { name: 'admin reports', as: 'admin', path: () => '/admin/reports' },
  { name: 'admin AI evaluation', as: 'admin', path: () => '/admin/evaluation' },
  { name: 'admin articles', as: 'admin', path: () => '/admin/knowledge' },
  { name: 'admin new article', as: 'admin', path: () => '/admin/knowledge/new' },
  { name: 'admin edit article', as: 'admin', path: (i) => `/admin/knowledge/${i.article}` },
];

async function open(page: Page, screen: Screen) {
  const api = await installMockApi(page);
  const [ticket] = api.seedTickets(3);
  const article = api.knowledge.articles().find((a) => a.isPublished)!;
  const ids = { ticket: ticket!.id, article: article.id };
  if (screen.as) await signIn(page, screen.as);
  await page.goto(screen.path(ids));
  await settle(page);
  return api;
}

test.describe('axe: no WCAG 2.2 A/AA violations', () => {
  for (const screen of SCREENS) {
    test(screen.name, async ({ page }) => {
      await open(page, screen);
      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(
        results.violations.map((v) => ({
          rule: v.id,
          impact: v.impact,
          targets: v.nodes.map((n) => n.target.join(' ')),
        })),
      ).toEqual([]);
    });
  }
});

test.describe('structure', () => {
  for (const screen of SCREENS) {
    test(`${screen.name}: one h1, a main landmark, a title`, async ({ page }) => {
      await open(page, screen);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('main')).toHaveCount(1);
      expect(await page.title()).not.toBe('');
    });
  }
});

test.describe('responsive: nothing overflows or is clipped', () => {
  test.skip(({ isMobile }) => isMobile, 'the width sweep sets its own viewports');
  for (const width of [320, 375, 768]) {
    for (const screen of SCREENS) {
      test(`${screen.name} at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await open(page, screen);
        const overflow = await page.evaluate(() => ({
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          // Visible controls whose right edge is past the viewport are clipped or unreachable.
          clipped: [
            ...document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea'),
          ]
            .filter((el) => {
              const box = el.getBoundingClientRect();
              return (
                box.width > 0 &&
                box.height > 0 &&
                getComputedStyle(el).visibility !== 'hidden' &&
                !el.closest('.sr-only, [aria-hidden="true"], [hidden]') &&
                !el.closest('.overflow-x-auto') &&
                box.right > document.documentElement.clientWidth + 1
              );
            })
            .map(
              (el) => `${el.tagName.toLowerCase()} ${(el.textContent ?? '').trim().slice(0, 30)}`,
            ),
        }));
        expect(overflow.page).toBeLessThanOrEqual(0);
        expect(overflow.clipped).toEqual([]);
      });
    }
  }
});

test.describe('keyboard only', () => {
  test.skip(({ isMobile }) => isMobile, 'keyboard navigation is a desktop concern');

  test('sign in with Tab, type and Enter', async ({ page }) => {
    await installMockApi(page);
    await page.goto('/login');
    await expect(page.getByLabel('Email')).toBeVisible();
    // The skip link is first; the form fields follow in reading order.
    await page.getByLabel('Email').focus();
    await page.keyboard.type(ACCOUNTS.employee.email);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password')).toBeFocused();
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/employee$/);
  });

  test('the skip link is the first stop and jumps to the content', async ({ page }) => {
    await open(
      page,
      SCREENS.find((s) => s.name === 'employee tickets')!,
    );
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });

  test('employee submits a ticket without a mouse and sees validation first', async ({ page }) => {
    const api = await open(
      page,
      SCREENS.find((s) => s.name === 'employee new ticket')!,
    );
    const before = api.tickets().length;
    await page.getByLabel('Title').focus();
    await page.keyboard.press('Tab'); // description
    await page.keyboard.press('Tab'); // submit
    await page.keyboard.press('Enter');
    // Errors are announced and focus moves to them.
    const summary = page.locator('[role="alert"]:not(#__next-route-announcer__)').first();
    await expect(summary).toBeFocused();
    await expect(summary).toContainText('There is a problem');

    await page.getByLabel('Title').focus();
    await page.keyboard.type('Keyboard only printer jam');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Tray 2 jams on every page.');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/employee\/tickets\/[^/]+\?created=1$/);
    expect(api.tickets()).toHaveLength(before + 1);
  });

  test('technician approves routing using only the keyboard', async ({ page }) => {
    const api = await open(
      page,
      SCREENS.find((s) => s.name === 'technician triage')!,
    );
    for (const [label, text] of [
      ['Category', 'Hardware'],
      ['Priority', 'High'],
      ['Team', 'Network'],
    ] as const) {
      await page.getByLabel(label, { exact: true }).focus();
      await page.keyboard.type(text); // type-ahead picks the option
    }
    await page.getByRole('button', { name: 'Approve routing' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('notice')).toBeVisible();
    const triaged = api.tickets().find((t) => t.status !== 'OPEN');
    expect(triaged).toBeTruthy();
  });

  test('admin reaches Reports through the navigation with Tab and Enter', async ({ page }) => {
    await open(
      page,
      SCREENS.find((s) => s.name === 'admin users')!,
    );
    const reports = page.getByRole('navigation', { name: 'Main' }).getByRole('link', {
      name: 'Reports',
    });
    let reached = false;
    for (let i = 0; i < 25 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await reports.evaluate((el) => el === document.activeElement);
    }
    expect(reached).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
  });

  test('a dialog traps focus, cancels with Escape and returns focus', async ({ page }) => {
    await open(
      page,
      SCREENS.find((s) => s.name === 'admin users')!,
    );
    const opener = page.getByRole('button', { name: 'Deactivate erin@smartdesk.test' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Deactivate this account?' });
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      // Focus may briefly leave the page (browser UI), but it never reaches the page behind.
      const behind = await page.evaluate(() => {
        const el = document.activeElement;
        return !!el && el !== document.body && !el.closest('dialog[open]');
      });
      expect(behind).toBe(false);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('focus is always visible on interactive controls', async ({ page }) => {
    await open(
      page,
      SCREENS.find((s) => s.name === 'employee new ticket')!,
    );
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      const style = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const css = getComputedStyle(el);
        return {
          outline: css.outlineStyle !== 'none' && parseFloat(css.outlineWidth) > 0,
          shadow: css.boxShadow !== 'none',
          skip: el.textContent?.trim() === 'Skip to content',
        };
      });
      expect(style).not.toBeNull();
      expect(style!.outline || style!.shadow).toBe(true);
    }
  });
});
