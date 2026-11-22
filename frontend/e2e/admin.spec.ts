import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, installMockApi, PASSWORD } from './helpers/mockApi';

async function signInAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ACCOUNTS.admin.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Admin area' })).toBeVisible();
}

const row = (page: Page, email: string) => page.getByRole('row').filter({ hasText: email });

test('lists every account with its role and status', async ({ page }) => {
  await installMockApi(page);
  await signInAsAdmin(page);
  const table = page.getByRole('table', { name: 'User accounts' });
  await expect(table.getByRole('row')).toHaveCount(5); // header + 4 users
  await expect(row(page, 'erin@smartdesk.test')).toContainText('Active');
  await expect(row(page, 'ivan.inactive@smartdesk.test')).toContainText('Inactive');
  await expect(page.getByLabel('Role for tara@smartdesk.test')).toHaveValue('TECHNICIAN');
});

test('creating a user shows the one-time password once and lists the account', async ({ page }) => {
  const api = await installMockApi(page);
  await signInAsAdmin(page);
  await page.getByLabel('Email', { exact: true }).fill('New.Hire@SmartDesk.test');
  await page.getByLabel('Display name').fill('New Hire');
  await page.getByLabel('Role', { exact: true }).selectOption('TECHNICIAN');
  await page.getByRole('button', { name: 'Create user' }).click();

  await expect(
    page.getByRole('heading', { name: 'One-time password for new.hire@smartdesk.test' }),
  ).toBeVisible();
  await expect(page.getByTestId('temporary-password')).toContainText('TempPw-');
  await expect(row(page, 'new.hire@smartdesk.test')).toContainText('Active');
  expect(api.adminUsers().find((u) => u.email === 'new.hire@smartdesk.test')?.role).toBe(
    'TECHNICIAN',
  );
  await expect(page.getByText(/created new\.hire@smartdesk\.test/)).toBeVisible();

  await page.getByRole('button', { name: /I have copied it/ }).click();
  await expect(page.getByTestId('temporary-password')).toHaveCount(0);
  // The password is not recoverable from the page after it is hidden or the page is reloaded.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Admin area' })).toBeVisible();
  await expect(page.getByText('TempPw-')).toHaveCount(0);
});

test('a duplicate email is reported without creating anything', async ({ page }) => {
  const api = await installMockApi(page);
  await signInAsAdmin(page);
  const before = api.adminUsers().length;
  await page.getByLabel('Email', { exact: true }).fill('ERIN@smartdesk.test');
  await page.getByLabel('Display name').fill('Another Erin');
  await page.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    'A user with this email already exists.',
  );
  expect(api.adminUsers()).toHaveLength(before);
  await expect(page.getByTestId('temporary-password')).toHaveCount(0);
});

test('deactivating and reactivating a user, with a confirmation and an audit entry', async ({
  page,
}) => {
  await installMockApi(page);
  await signInAsAdmin(page);

  const dialog = page.getByRole('dialog', { name: 'Deactivate this account?' });
  const opener = page.getByRole('button', { name: 'Deactivate erin@smartdesk.test' });
  await opener.click();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused(); // focus returns to what opened it
  await expect(row(page, 'erin@smartdesk.test')).toContainText('Active'); // cancelled: unchanged

  await opener.click();
  await dialog.getByRole('button', { name: 'Deactivate' }).click();
  await expect(row(page, 'erin@smartdesk.test')).toContainText('Inactive');
  await expect(page.getByText(/deactivated erin@smartdesk\.test/)).toBeVisible();

  await page.getByRole('button', { name: 'Activate erin@smartdesk.test' }).click();
  await expect(row(page, 'erin@smartdesk.test')).toContainText('Active');
  await expect(page.getByText(/activated erin@smartdesk\.test/).first()).toBeVisible();
});

test('changing a role updates the list and the audit trail', async ({ page }) => {
  const api = await installMockApi(page);
  await signInAsAdmin(page);
  await page.getByLabel('Role for erin@smartdesk.test').selectOption('TECHNICIAN');
  await expect(
    page.getByText(/changed the role of erin@smartdesk\.test \(EMPLOYEE to TECHNICIAN\)/),
  ).toBeVisible();
  expect(api.adminUsers().find((u) => u.email === 'erin@smartdesk.test')?.role).toBe('TECHNICIAN');
});

test('resetting a password shows a fresh one-time password', async ({ page }) => {
  await installMockApi(page);
  await signInAsAdmin(page);
  await page.getByRole('button', { name: 'Reset password for tara@smartdesk.test' }).click();
  await page
    .getByRole('dialog', { name: 'Issue a new one-time password?' })
    .getByRole('button', { name: 'Reset password' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'One-time password for tara@smartdesk.test' }),
  ).toBeVisible();
  await expect(page.getByTestId('temporary-password')).toContainText('Reset-');
});

test('administrators cannot target their own account from the UI', async ({ page }) => {
  await installMockApi(page);
  await signInAsAdmin(page);
  await expect(page.getByLabel('Role for admin@smartdesk.test')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Deactivate admin@smartdesk.test' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Reset password for admin@smartdesk.test' }),
  ).toBeDisabled();
});

test('the admin page fits a phone screen (the table scrolls inside its own container)', async ({
  page,
}) => {
  await installMockApi(page);
  await signInAsAdmin(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('non-admins never see the user administration', async ({ page }) => {
  await installMockApi(page);
  await page.goto('/login');
  await page.getByLabel('Email').fill(ACCOUNTS.technician.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/technician$/);
  await expect(page.getByRole('heading', { name: 'User accounts' })).toHaveCount(0);
});
