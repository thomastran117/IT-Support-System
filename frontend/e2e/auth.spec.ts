import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, installMockApi, PASSWORD, type AccountKey } from './helpers/mockApi';

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const roles = Object.keys(ACCOUNTS) as AccountKey[];

for (const key of roles) {
  const a = ACCOUNTS[key];

  test(`${key} signs in and lands on ${a.portal}`, async ({ page }) => {
    await installMockApi(page);
    await signIn(page, a.email);
    await expect(page).toHaveURL(new RegExp(`${a.portal}$`));
    await expect(page.getByRole('heading', { level: 1, name: a.heading })).toBeVisible();
    await expect(page.getByTestId('current-user')).toHaveText(a.displayName);
  });
}

test('invalid credentials show a generic message and stay on the form', async ({ page }) => {
  const api = await installMockApi(page);
  await signIn(page, ACCOUNTS.employee.email, 'wrong-password');
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Invalid email or password.');
  await signIn(page, 'nobody@smartdesk.test');
  // Unknown account and wrong password are indistinguishable.
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Invalid email or password.');
  await expect(page).toHaveURL(/\/login$/);
  expect(api.count('login')).toBe(2);
});

test('empty and malformed input is rejected on the client with visible, accessible messages', async ({
  page,
}) => {
  const api = await installMockApi(page);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Enter your email address.')).toBeVisible();
  await expect(page.getByText('Enter your password.')).toBeVisible();
  await expect(page.getByLabel('Email')).toBeFocused();
  await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');

  await page.getByLabel('Email').fill('not-an-email');
  await page.getByLabel('Password').fill('x');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Enter a valid email address.')).toBeVisible();
  expect(api.count('login')).toBe(0);
});

test('network failure while signing in shows a useful, non-sensitive message', async ({ page }) => {
  const api = await installMockApi(page);
  await page.goto('/login');
  api.setOffline(true);
  await page.getByLabel('Email').fill(ACCOUNTS.employee.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Unable to reach the server',
  );
  // The user can retry once the network is back.
  api.setOffline(false);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/employee$/);
});

test('too many attempts is reported plainly', async ({ page }) => {
  const api = await installMockApi(page);
  api.rateLimitLogins(true);
  await signIn(page, ACCOUNTS.employee.email);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Too many attempts');
});

test('the session survives a reload and is restored from the refresh cookie', async ({ page }) => {
  const api = await installMockApi(page);
  await signIn(page, ACCOUNTS.technician.email);
  await expect(page).toHaveURL(/\/technician$/);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Technician dashboard' })).toBeVisible();
  await expect(page.getByTestId('current-user')).toHaveText('Tara Technician');
  expect(api.count('refresh')).toBeGreaterThanOrEqual(1);
});

test('access token never reaches storage, cookies or the URL', async ({ page }) => {
  await installMockApi(page);
  await signIn(page, ACCOUNTS.admin.email);
  await expect(page).toHaveURL(/\/admin$/);
  const leaked = await page.evaluate(() => {
    const everything = [
      ...Object.entries(localStorage),
      ...Object.entries(sessionStorage),
      ['cookie', document.cookie],
      ['url', location.href],
    ].flat();
    return everything.filter((v) => String(v).includes('access-'));
  });
  expect(leaked).toEqual([]);
});

test('sign out clears state and blocks protected routes', async ({ page }) => {
  const api = await installMockApi(page);
  await signIn(page, ACCOUNTS.employee.email);
  await expect(page).toHaveURL(/\/employee$/);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('current-user')).toHaveCount(0);
  expect(api.count('logout')).toBe(1);

  await page.goto('/employee');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'My tickets' })).toHaveCount(0);
});

test('anonymous visitors are sent to sign in from every portal', async ({ page }) => {
  await installMockApi(page);
  for (const key of roles) {
    await page.goto(ACCOUNTS[key].portal);
    await expect(page).toHaveURL(/\/login$/);
  }
});

test('a signed-in user is redirected away from other roles’ portals', async ({ page }) => {
  await installMockApi(page);
  await signIn(page, ACCOUNTS.employee.email);
  await expect(page).toHaveURL(/\/employee$/);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/employee$/);
  await expect(page.getByRole('heading', { name: 'Admin area' })).toHaveCount(0);
  await page.goto('/technician');
  await expect(page).toHaveURL(/\/employee$/);
});

test('visiting /login while signed in goes straight to the portal', async ({ page }) => {
  await installMockApi(page);
  await signIn(page, ACCOUNTS.technician.email);
  await expect(page).toHaveURL(/\/technician$/);
  await page.goto('/login');
  await expect(page).toHaveURL(/\/technician$/);
});

test('a revoked session is noticed when the tab regains focus, without redirect loops', async ({
  page,
}) => {
  const api = await installMockApi(page);
  await signIn(page, ACCOUNTS.employee.email);
  await expect(page).toHaveURL(/\/employee$/);

  const refreshesBefore = api.count('refresh');
  api.revokeSession(); // server disabled the account / cookie expired
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    'Your session has ended. Please sign in again.',
  );
  await expect(page.getByTestId('current-user')).toHaveCount(0);
  // One failed /me, exactly one refresh attempt, and nothing further.
  await page.waitForTimeout(500);
  expect(api.count('me')).toBe(1);
  expect(api.count('refresh') - refreshesBefore).toBe(1);
});

test('reloading after the account was disabled lands on sign in once', async ({ page }) => {
  const api = await installMockApi(page);
  await signIn(page, ACCOUNTS.admin.email);
  await expect(page).toHaveURL(/\/admin$/);
  const before = api.count('refresh');
  api.revokeSession();
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await page.waitForTimeout(500);
  expect(api.count('refresh') - before).toBe(1);
});

test('the server being down on load is reported on the sign-in page', async ({ page }) => {
  const api = await installMockApi(page);
  api.setOffline(true);
  await page.goto('/login');
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Unable to reach the server',
  );
});

test('keyboard only: tab through the form and submit with Enter', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard navigation is a desktop concern');
  await installMockApi(page);
  await page.goto('/login');
  await page.getByLabel('Email').focus();
  await page.keyboard.type(ACCOUNTS.employee.email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password')).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/employee$/);
});

test('the form fits a phone screen without horizontal scrolling', async ({ page }) => {
  await installMockApi(page);
  await page.goto('/login');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
