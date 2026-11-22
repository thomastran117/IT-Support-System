import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, installMockApi, PASSWORD } from './helpers/mockApi';

async function signIn(page: Page, account: keyof typeof ACCOUNTS) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ACCOUNTS[account].email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${ACCOUNTS[account].portal}$`));
}

const item = (page: Page, name: string) => page.getByRole('listitem', { name, exact: true });

async function openCategories(page: Page) {
  await page.goto('/admin/categories');
  await expect(page.getByRole('heading', { level: 1, name: 'Categories' })).toBeVisible();
  await expect(item(page, 'Hardware')).toBeVisible();
}
async function openTeams(page: Page) {
  await page.goto('/admin/teams');
  await expect(page.getByRole('heading', { level: 1, name: 'Support teams' })).toBeVisible();
  await expect(item(page, 'Network & Access')).toBeVisible();
}

test.describe('categories', () => {
  test('lists categories with status and how many tickets use them', async ({ page }) => {
    await installMockApi(page);
    await signIn(page, 'admin');
    await openCategories(page);
    for (const name of ['Hardware', 'Software', 'Network/VPN']) {
      await expect(item(page, name)).toContainText('Active');
      await expect(item(page, name)).toContainText(/\d+ tickets?/);
    }
  });

  test('adds a category, rejects an empty name locally and explains a duplicate', async ({
    page,
  }) => {
    await installMockApi(page);
    await signIn(page, 'admin');
    await openCategories(page);

    await page.getByRole('button', { name: 'Add category' }).click();
    await expect(page.getByText('Enter a name.')).toBeVisible();

    await page.getByLabel('Name').first().fill('Security');
    await page.getByLabel('Description (optional)').first().fill('Incidents and phishing');
    await page.getByRole('button', { name: 'Add category' }).click();
    await expect(page.getByText('Category “Security” added.')).toBeVisible();
    await expect(item(page, 'Security')).toContainText('Incidents and phishing');
    await expect(item(page, 'Security')).toContainText('0 tickets');

    await page.getByLabel('Name').first().fill('hardware');
    await page.getByRole('button', { name: 'Add category' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('already exists');
  });

  test('renames a category', async ({ page }) => {
    await installMockApi(page);
    await signIn(page, 'admin');
    await openCategories(page);
    await page.getByRole('button', { name: 'Edit Software' }).click();
    await page.getByLabel('Name').nth(1).fill('Applications');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Category “Applications” saved.')).toBeVisible();
    await expect(item(page, 'Applications')).toBeVisible();
    await expect(item(page, 'Software')).toHaveCount(0);
  });

  test('deactivation explains its effect, keeps the tickets, and reactivation restores the choice', async ({
    page,
  }) => {
    await installMockApi(page);
    await signIn(page, 'admin');
    await openCategories(page);
    const before = await item(page, 'Software').textContent();
    const tickets = /(\d+ tickets?)/.exec(before ?? '')![1]!;

    await page.getByRole('button', { name: 'Deactivate Software' }).click();
    const confirm = page.getByRole('group', { name: 'Deactivate “Software”?' });
    await expect(confirm).toContainText('no longer be offered');
    await expect(confirm).toContainText(`already filed under it`);
    await expect(confirm).toContainText('reactivate it at any time');
    // Nothing happens until it is confirmed.
    await expect(item(page, 'Software')).toContainText('Active');
    await confirm.getByRole('button', { name: 'Confirm deactivation' }).click();

    await expect(page.getByText('Category “Software” deactivated.')).toBeVisible();
    await expect(item(page, 'Software')).toContainText('Inactive');
    await expect(item(page, 'Software')).toContainText(tickets); // history is unchanged

    // New triage no longer sees it: the evaluation label form lists only active categories.
    await page.goto('/admin/evaluation');
    const options = page.getByLabel('Reference category').locator('option');
    await expect(options.filter({ hasText: 'Software' })).toHaveCount(0);
    await expect(options.filter({ hasText: 'Hardware' })).toHaveCount(1);

    await page.goto('/admin/categories');
    await page.getByRole('button', { name: 'Reactivate Software' }).click();
    await expect(page.getByText('Category “Software” is active again.')).toBeVisible();
    await expect(item(page, 'Software')).toContainText('Active');
    await page.goto('/admin/evaluation');
    await expect(
      page.getByLabel('Reference category').locator('option').filter({ hasText: 'Software' }),
    ).toHaveCount(1);
  });

  test('cancelling a deactivation changes nothing; search and status filter narrow the list', async ({
    page,
  }) => {
    await installMockApi(page);
    await signIn(page, 'admin');
    await openCategories(page);
    await page.getByRole('button', { name: 'Deactivate Hardware' }).click();
    await page.getByRole('button', { name: 'Keep active' }).click();
    await expect(item(page, 'Hardware')).toContainText('Active');

    await page.getByLabel('Search').fill('net');
    await expect(item(page, 'Network/VPN')).toBeVisible();
    await expect(item(page, 'Hardware')).toHaveCount(0);
    await page.getByLabel('Search').fill('zzz');
    await expect(page.getByText('No categories match')).toBeVisible();
  });

  test('a load error offers a retry that recovers', async ({ page }) => {
    const api = await installMockApi(page);
    await signIn(page, 'admin');
    api.failNext('catalog', 500);
    await page.goto('/admin/categories');
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Something went wrong');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(item(page, 'Hardware')).toBeVisible();
  });
});

test.describe('teams', () => {
  test('lists teams with member and ticket counts', async ({ page }) => {
    await installMockApi(page);
    await signIn(page, 'admin');
    await openTeams(page);
    await expect(item(page, 'Network & Access')).toContainText('2 members');
    await expect(item(page, 'Hardware & Devices')).toContainText('2 members');
    await expect(item(page, 'Network & Access')).toContainText(/\d+ tickets?/);
  });

  test('creates a team, explains a duplicate, and deactivates and reactivates it', async ({
    page,
  }) => {
    await installMockApi(page);
    await signIn(page, 'admin');
    await openTeams(page);

    await page.getByLabel('Name').first().fill('Security');
    await page.getByRole('button', { name: 'Add team' }).click();
    await expect(page.getByText('Team “Security” added.')).toBeVisible();
    await expect(item(page, 'Security')).toContainText('0 members');

    await page.getByLabel('Name').first().fill('Security');
    await page.getByRole('button', { name: 'Add team' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('already exists');

    await page.getByRole('button', { name: 'Deactivate Security' }).click();
    const confirm = page.getByRole('group', { name: 'Deactivate “Security”?' });
    await expect(confirm).toContainText('no longer be offered when tickets are routed');
    await expect(confirm).toContainText('keep it as their team');
    await confirm.getByRole('button', { name: 'Confirm deactivation' }).click();
    await expect(item(page, 'Security')).toContainText('Inactive');
    await expect(page.getByRole('button', { name: 'Reactivate Security' })).toBeVisible();

    await page.getByRole('button', { name: 'Reactivate Security' }).click();
    await expect(item(page, 'Security')).toContainText('Active');
  });

  test('adds and removes a member, offering only technicians who are not already in the team', async ({
    page,
  }) => {
    const api = await installMockApi(page);
    await signIn(page, 'admin');
    await openTeams(page);

    await page.getByRole('button', { name: 'Manage members of Network & Access' }).click();
    const roster = page.getByRole('list', { name: 'Members of Network & Access' });
    await expect(roster).toContainText('Tara Technician');
    await expect(roster).toContainText('Tom Technician');

    const select = page.getByLabel('Add a technician');
    await expect(select.locator('option', { hasText: 'Tara' })).toHaveCount(0); // already a member
    await select.selectOption({ label: 'Hana Technician' });
    await page.getByRole('button', { name: 'Add to team' }).click();
    await expect(roster).toContainText('Hana Technician');
    await expect(item(page, 'Network & Access')).toContainText('3 members');

    await page
      .getByRole('button', { name: 'Remove Hana Technician from Network & Access' })
      .click();
    await expect(roster).not.toContainText('Hana Technician');
    await expect(item(page, 'Network & Access')).toContainText('2 members');
    expect(api.memberActions().map((a) => a.action)).toEqual(['add', 'remove']);
  });

  test('refuses to remove a member who still holds tickets, and says why', async ({ page }) => {
    const api = await installMockApi(page);
    await signIn(page, 'admin');
    await openTeams(page);
    await page.getByRole('button', { name: 'Manage members of Hardware & Devices' }).click();
    await page
      .getByRole('button', { name: 'Remove Tom Technician from Hardware & Devices' })
      .click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'still has tickets assigned',
    );
    await expect(page.getByRole('list', { name: 'Members of Hardware & Devices' })).toContainText(
      'Tom Technician',
    );
    expect(api.memberActions()).toEqual([]);
  });

  test('an inactive team keeps its members but takes no new ones', async ({ page }) => {
    await installMockApi(page);
    await signIn(page, 'admin');
    await openTeams(page);
    await page.getByRole('button', { name: 'Deactivate Network & Access' }).click();
    await page.getByRole('button', { name: 'Confirm deactivation' }).click();
    await expect(item(page, 'Network & Access')).toContainText('Inactive');
    await page.getByRole('button', { name: 'Manage members of Network & Access' }).click();
    await expect(page.getByText('Reactivate the team to add members.')).toBeVisible();
    await expect(page.getByLabel('Add a technician')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Members of Network & Access' })).toContainText(
      'Tara Technician',
    );
  });
});

test('employees and technicians cannot open the catalog pages', async ({ page }) => {
  await installMockApi(page);
  await signIn(page, 'employee');
  for (const path of ['/admin/categories', '/admin/teams']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/employee$/);
  }
  const second = await page.context().newPage();
  await installMockApi(second);
  await signIn(second, 'technician');
  for (const path of ['/admin/categories', '/admin/teams']) {
    await second.goto(path);
    await expect(second).toHaveURL(/\/technician$/);
  }
});

for (const [path, name] of [
  ['/admin/categories', 'Hardware'],
  ['/admin/teams', 'Network & Access'],
] as const) {
  test(`${path} fits a phone screen without sideways scrolling`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await installMockApi(page);
    await signIn(page, 'admin');
    await page.goto(path);
    await expect(item(page, name)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
