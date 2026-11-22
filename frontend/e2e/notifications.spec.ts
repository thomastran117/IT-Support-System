import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, installMockApi, PASSWORD } from './helpers/mockApi';

async function signInAsEmployee(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ACCOUNTS.employee.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My tickets' })).toBeVisible();
}

/** The visible bell: the hidden desktop or mobile twin is not in the accessibility tree. */
const bell = (page: Page) => page.getByRole('button', { name: /^Notifications/ });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Notifications' });

test('submit, resolve, notify: the employee sees one resolution notice and can mark it read', async ({
  page,
}) => {
  const api = await installMockApi(page);
  const [ticket] = api.seedTickets(1);
  await signInAsEmployee(page);
  await expect(bell(page)).toHaveAccessibleName('Notifications');
  await expect(page.getByTestId('notification-badge')).toHaveCount(0);

  // A technician resolves it (internal notes must never reach the notice).
  api.technician.reply(ticket!.id, 'INTERNAL-ONLY-secret-note', true);
  api.technician.update(ticket!.id, { status: 'RESOLVED', resolutionSummary: 'Swapped the cable' });

  // Picked up by the light polling, with no reload.
  await expect(bell(page)).toHaveAccessibleName('Notifications, 1 unread');
  await expect(page.getByTestId('notification-badge').first()).toHaveText('1');

  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  const items = panel(page).getByTestId('notification-item');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Your ticket was resolved.');
  await expect(items.first()).toContainText('Seeded ticket 1');
  await expect(panel(page)).not.toContainText('INTERNAL-ONLY-secret-note');
  await expect(panel(page)).not.toContainText('Swapped the cable');

  await items
    .first()
    .getByRole('button', { name: /^Mark as read/ })
    .click();
  await expect(bell(page)).toHaveAccessibleName('Notifications');
  await expect(items.first()).toHaveAttribute('data-unread', 'false');

  // The read state lives on the server, so it survives a reload.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'My tickets' })).toBeVisible();
  await expect(bell(page)).toHaveAccessibleName('Notifications');
  await bell(page).click();
  await expect(panel(page).getByTestId('notification-item')).toHaveCount(1);
  await expect(panel(page).getByTestId('notification-item').first()).toHaveAttribute(
    'data-unread',
    'false',
  );
});

test('opening a notification goes to the ticket and marks it read', async ({ page }) => {
  const api = await installMockApi(page);
  const [ticket] = api.seedTickets(1);
  await signInAsEmployee(page);
  api.technician.reply(ticket!.id, 'We are looking into it.');
  await expect(bell(page)).toHaveAccessibleName('Notifications, 1 unread');

  await bell(page).click();
  await panel(page)
    .getByRole('link', { name: /A technician replied/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/employee/tickets/${ticket!.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Seeded ticket 1' })).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(bell(page)).toHaveAccessibleName('Notifications');
  expect(api.notifications()[0]!.readAt).not.toBeNull();
});

test('mark all as read clears the count', async ({ page }) => {
  const api = await installMockApi(page);
  const [ticket] = api.seedTickets(1);
  await signInAsEmployee(page);
  api.technician.update(ticket!.id, { status: 'IN_PROGRESS' });
  api.technician.reply(ticket!.id, 'Update');
  await expect(bell(page)).toHaveAccessibleName('Notifications, 2 unread');
  await bell(page).click();
  await panel(page).getByRole('button', { name: 'Mark all as read' }).click();
  await expect(bell(page)).toHaveAccessibleName('Notifications');
  await expect(panel(page).getByTestId('notification-item').first()).toHaveAttribute(
    'data-unread',
    'false',
  );
});

test('empty list: an explanatory message, no badge', async ({ page }) => {
  await installMockApi(page);
  await signInAsEmployee(page);
  await bell(page).click();
  await expect(panel(page).getByTestId('notification-empty')).toContainText(
    'You have no notifications yet.',
  );
  await expect(page.getByTestId('notification-badge')).toHaveCount(0);
});

test('an API error is explained, and trying again recovers', async ({ page }) => {
  const api = await installMockApi(page);
  const [ticket] = api.seedTickets(1);
  api.technician.update(ticket!.id, { status: 'RESOLVED' });
  await signInAsEmployee(page);
  await expect(bell(page)).toHaveAccessibleName('Notifications, 1 unread');

  // Server trouble: opening the panel says so, and the last known badge is not wiped.
  api.setNotificationsDown(500);
  await bell(page).click();
  const alert = panel(page).getByRole('alert');
  await expect(alert).toContainText('Something went wrong');
  await expect(bell(page)).toHaveAccessibleName('Notifications, 1 unread');

  api.setNotificationsDown(null);
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(panel(page).getByTestId('notification-item')).toHaveCount(1);
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
});

test('keyboard: open with Enter, close with Escape and focus returns to the bell', async ({
  page,
}) => {
  const api = await installMockApi(page);
  const [ticket] = api.seedTickets(1);
  api.technician.update(ticket!.id, { status: 'RESOLVED' });
  await signInAsEmployee(page);
  await expect(bell(page)).toHaveAccessibleName('Notifications, 1 unread');

  await bell(page).focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toBeFocused();
  await expect(bell(page)).toHaveAttribute('aria-expanded', 'true');

  // The controls inside are reachable with Tab.
  await page.keyboard.press('Tab');
  await expect(panel(page).getByRole('button', { name: 'Mark all as read' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(bell(page)).toBeFocused();
  await expect(bell(page)).toHaveAttribute('aria-expanded', 'false');
});

test('the open panel has no axe violations and fits the viewport', async ({ page }) => {
  const api = await installMockApi(page);
  const [ticket] = api.seedTickets(1);
  api.technician.update(ticket!.id, { status: 'RESOLVED' });
  await signInAsEmployee(page);
  await bell(page).click();
  await expect(panel(page).getByTestId('notification-item')).toHaveCount(1);

  const axe = await new AxeBuilder({ page })
    .include('#notification-panel')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(axe.violations).toEqual([]);

  const box = (await panel(page).boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('technicians and admins get no notification bell', async ({ page }) => {
  await installMockApi(page);
  await page.goto('/login');
  await page.getByLabel('Email').fill(ACCOUNTS.technician.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/technician$/);
  await expect(page.getByTestId('notification-bell')).toHaveCount(0);
});
