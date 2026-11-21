import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, installMockApi, PASSWORD } from './helpers/mockApi';

async function signInAsEmployee(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ACCOUNTS.employee.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My tickets' })).toBeVisible();
}

async function submitTicket(page: Page, title: string, description: string) {
  await page.getByRole('link', { name: 'New ticket' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New ticket' })).toBeVisible();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Description').fill(description);
  await page.getByRole('button', { name: 'Submit ticket' }).click();
}

const progress = (page: Page) => page.locator('[aria-current="step"]');

test('employee journey: submit, find, open, reply and see the technician update', async ({
  page,
}) => {
  const api = await installMockApi(page);
  await signInAsEmployee(page);

  // Nothing yet: an explanatory empty state, not a blank table.
  await expect(page.getByText('You have not submitted any tickets yet.')).toBeVisible();

  // Submit. The detail page confirms it and shows a readable tracking ID.
  await submitTicket(page, 'VPN drops every hour', 'The client asks me to sign in again hourly.');
  await expect(page.getByRole('heading', { level: 1, name: 'VPN drops every hour' })).toBeVisible();
  await expect(page.getByText('Your ticket was submitted.')).toBeVisible();
  const trackingId = (await page.getByTestId('tracking-id').textContent())!;
  expect(trackingId).toMatch(/^[0-9a-f-]{36}$/);
  expect(api.tickets()[0]!.id).toBe(trackingId);
  await expect(progress(page)).toContainText('Open');
  await expect(page.getByTestId('timeline-entry')).toHaveText([/Ticket submitted/]);

  // It is findable from the list.
  await page.getByRole('article').getByRole('link', { name: 'My tickets', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'VPN drops every hour' });
  await expect(row).toContainText('Open');
  await expect(row).toContainText('Not set yet');
  await row.getByRole('link', { name: 'VPN drops every hour' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'VPN drops every hour' })).toBeVisible();
  // The confirmation is only for the redirect right after submitting.
  await expect(page.getByText('Your ticket was submitted.')).toHaveCount(0);

  // Reply.
  await expect(page.getByText('No replies yet.')).toBeVisible();
  await page.getByLabel('Reply').fill('It also happens on the guest network.');
  await page.getByRole('button', { name: 'Send reply' }).click();
  const comments = page.getByTestId('comment');
  await expect(comments).toHaveCount(1);
  await expect(comments.first()).toContainText('You');
  await expect(comments.first()).toContainText('It also happens on the guest network.');
  await expect(page.getByLabel('Reply')).toHaveValue('');

  // A technician triages it, replies publicly and leaves an internal note. The open page updates
  // by itself, with no reload.
  const id = api.tickets()[0]!.id;
  api.technician.update(id, {
    category: 'Network/VPN',
    team: 'Network & Access',
    priority: 'HIGH',
    status: 'TRIAGED',
  });
  api.technician.reply(id, 'Thanks, I am checking your VPN profile now.');
  api.technician.reply(id, 'INTERNAL-ONLY escalate to security', true);
  api.technician.update(id, { status: 'IN_PROGRESS' });

  await expect(progress(page)).toContainText('In progress');
  await expect(page.getByText('Network/VPN')).toBeVisible();
  await expect(page.getByText('Network & Access')).toBeVisible();
  await expect(page.getByText('High', { exact: true })).toBeVisible();
  await expect(comments).toHaveCount(2);
  await expect(comments.nth(1)).toContainText('Tara Technician');
  await expect(comments.nth(1)).toContainText('checking your VPN profile');
  await expect(page.getByText('Status changed from Triaged to In progress')).toBeVisible();
  // Internal notes never reach the page.
  await expect(page.getByText('INTERNAL-ONLY')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('escalate to security');

  // Resolution is visible too.
  api.technician.update(id, { status: 'RESOLVED', resolutionSummary: 'Renewed the VPN profile.' });
  await expect(progress(page)).toContainText('Resolved');
  await expect(page.getByText('Renewed the VPN profile.')).toBeVisible();

  // And the list reflects the new state after a reload.
  await page.goto('/employee');
  await expect(page.getByRole('row').filter({ hasText: 'VPN drops every hour' })).toContainText(
    'Resolved',
  );
});

test("only your own tickets: another employee's ticket cannot be opened", async ({ page }) => {
  const api = await installMockApi(page);
  const foreign = api.seedForeignTicket();
  api.seedTickets(1);
  await signInAsEmployee(page);
  await expect(page.getByText('Omar private issue')).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'Seeded ticket 1' })).toHaveCount(1);

  await page.goto(`/employee/tickets/${foreign.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Ticket not found' })).toBeVisible();
  await expect(page.getByText('Omar private issue')).toHaveCount(0);
  await expect(page.getByText('Not yours')).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to my tickets' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My tickets' })).toBeVisible();
});

test.describe('the submit form', () => {
  test('explains every problem in a summary that links to the fields, and keeps focus there', async ({
    page,
  }) => {
    const api = await installMockApi(page);
    await signInAsEmployee(page);
    await page.getByRole('link', { name: 'New ticket' }).first().click();
    await page.getByRole('button', { name: 'Submit ticket' }).click();

    const summary = page
      .getByRole('main')
      .getByRole('alert')
      .filter({ hasText: 'There is a problem' });
    await expect(summary).toBeVisible();
    await expect(summary).toBeFocused();
    await expect(summary.getByRole('link')).toHaveText(['Enter a title.', 'Enter a description.']);
    await expect(page.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');
    expect(api.createRequests()).toBe(0); // invalid input never reaches the server

    // The summary link moves focus to the field.
    await summary.getByRole('link', { name: 'Enter a title.' }).click();
    await expect(page.getByLabel('Title')).toBeFocused();

    // The same limits as the API: 150 characters for the title.
    await page.getByLabel('Title').fill('x'.repeat(151));
    await page.getByLabel('Description').fill('Something is wrong.');
    await expect(page.getByText('151 of 150 characters (too long)')).toBeVisible();
    await page.getByRole('button', { name: 'Submit ticket' }).click();
    await expect(summary.getByRole('link')).toHaveText(['Title must be 150 characters or fewer.']);
    expect(api.createRequests()).toBe(0);
  });

  test('a server error keeps the draft, and retrying creates exactly one ticket', async ({
    page,
  }) => {
    const api = await installMockApi(page);
    await signInAsEmployee(page);
    await page.getByRole('link', { name: 'New ticket' }).first().click();
    await page.getByLabel('Title').fill('Printer jams');
    await page.getByLabel('Description').fill('Tray 2 jams on every second page.');

    api.failNext('create', 500);
    await page.getByRole('button', { name: 'Submit ticket' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'Something went wrong on our side',
    );
    await expect(page.getByLabel('Title')).toHaveValue('Printer jams');
    await expect(page.getByLabel('Description')).toHaveValue('Tray 2 jams on every second page.');
    expect(api.tickets()).toHaveLength(0);

    // Network failure: same, and still nothing lost.
    api.failNext('create', 'network');
    await page.getByRole('button', { name: 'Submit ticket' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'Unable to reach the server',
    );
    await expect(page.getByLabel('Title')).toHaveValue('Printer jams');

    await page.getByRole('button', { name: 'Submit ticket' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Printer jams' })).toBeVisible();
    expect(api.tickets()).toHaveLength(1);
    // Every attempt carried the same idempotency key, so a lost response cannot duplicate it.
    const keys = api.createKeys();
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a double click submits once', async ({ page }) => {
    const api = await installMockApi(page);
    await signInAsEmployee(page);
    await page.getByRole('link', { name: 'New ticket' }).first().click();
    await page.getByLabel('Title').fill('Double click');
    await page.getByLabel('Description').fill('Clicked twice.');
    await page.getByRole('button', { name: 'Submit ticket' }).dblclick();
    await expect(page.getByRole('heading', { level: 1, name: 'Double click' })).toBeVisible();
    expect(api.tickets()).toHaveLength(1);
    expect(api.createRequests()).toBe(1);
  });

  test('an unsent draft survives a reload and is cleared once submitted', async ({ page }) => {
    const api = await installMockApi(page);
    await signInAsEmployee(page);
    await page.getByRole('link', { name: 'New ticket' }).first().click();
    await page.getByLabel('Title').fill('Half written');
    await page.getByLabel('Description').fill('To be continued');
    await page.reload();
    await expect(page.getByLabel('Title')).toHaveValue('Half written');
    await expect(page.getByLabel('Description')).toHaveValue('To be continued');

    await page.getByRole('button', { name: 'Submit ticket' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Half written' })).toBeVisible();
    expect(api.tickets()).toHaveLength(1);
    await page.goto('/employee/tickets/new');
    await expect(page.getByLabel('Title')).toHaveValue('');
  });

  test('keyboard only: fill in and submit', async ({ page, isMobile }) => {
    test.skip(isMobile, 'keyboard navigation is a desktop concern');
    await installMockApi(page);
    await signInAsEmployee(page);
    await page.getByRole('link', { name: 'New ticket' }).first().click();
    await page.getByLabel('Title').focus();
    await page.keyboard.type('Keyboard ticket');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Description')).toBeFocused();
    await page.keyboard.type('Submitted without a mouse.');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Submit ticket' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Keyboard ticket' })).toBeVisible();
  });
});

test.describe('the ticket list', () => {
  test('pages through newest first, with an accurate range', async ({ page }) => {
    const api = await installMockApi(page);
    api.seedTickets(25);
    await signInAsEmployee(page);

    const titles = () => page.getByRole('rowheader').allTextContents();
    await expect(page.getByText('Showing 1–10 of 25')).toBeVisible();
    expect(await titles()).toEqual(Array.from({ length: 10 }, (_, i) => `Seeded ticket ${25 - i}`));
    await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();

    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Showing 11–20 of 25')).toBeVisible();
    expect((await titles())[0]).toBe('Seeded ticket 15');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Showing 21–25 of 25')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();

    await page.getByRole('button', { name: 'Previous' }).click();
    await expect(page.getByText('Showing 11–20 of 25')).toBeVisible();
  });

  test('filters by status and says so when nothing matches', async ({ page }) => {
    const api = await installMockApi(page);
    const [a] = api.seedTickets(3);
    api.technician.update(a!.id, {
      category: 'Hardware',
      team: 'Hardware',
      priority: 'LOW',
      status: 'TRIAGED',
    });
    await signInAsEmployee(page);

    await page.getByLabel('Status').selectOption('TRIAGED');
    await expect(page.getByText('Showing 1–1 of 1')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Seeded ticket 1' })).toContainText(
      'Triaged',
    );
    await page.getByLabel('Priority').selectOption('CRITICAL');
    await expect(page.getByText('No tickets match these filters.')).toBeVisible();
    await page.getByLabel('Priority').selectOption('');
    await page.getByLabel('Status').selectOption('');
    await expect(page.getByText('Showing 1–3 of 3')).toBeVisible();
  });

  test('shows an error with a retry, and recovers', async ({ page }) => {
    const api = await installMockApi(page);
    api.seedTickets(2);
    api.failNext('list', 500);
    await page.goto('/login');
    await page.getByLabel('Email').fill(ACCOUNTS.employee.email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'Something went wrong on our side',
    );
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText('Showing 1–2 of 2')).toBeVisible();
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  });
});

test.describe('the ticket page', () => {
  test('keeps what you see when updates cannot be fetched, and recovers', async ({ page }) => {
    const api = await installMockApi(page);
    const [t] = api.seedTickets(1);
    await signInAsEmployee(page);
    await page.getByRole('link', { name: 'Seeded ticket 1' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Seeded ticket 1' })).toBeVisible();

    api.setOffline(true);
    await expect(page.getByText('Unable to check for updates right now.')).toBeVisible();
    // The page is still fully there.
    await expect(page.getByRole('heading', { level: 1, name: 'Seeded ticket 1' })).toBeVisible();
    await expect(page.getByLabel('Reply')).toBeVisible();

    api.setOffline(false);
    api.technician.update(t!.id, { status: 'TRIAGED', priority: 'MEDIUM', team: 'Network' });
    await expect(page.getByText('Unable to check for updates right now.')).toHaveCount(0);
    await expect(progress(page)).toContainText('Triaged');
  });

  test('a failed reply keeps the text so it can be sent again', async ({ page }) => {
    const api = await installMockApi(page);
    api.seedTickets(1);
    await signInAsEmployee(page);
    await page.getByRole('link', { name: 'Seeded ticket 1' }).click();
    await page.getByLabel('Reply').fill('Please hurry.');
    api.failNext('reply', 500);
    await page.getByRole('button', { name: 'Send reply' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'Something went wrong on our side',
    );
    await expect(page.getByLabel('Reply')).toHaveValue('Please hurry.');
    await page.getByRole('button', { name: 'Send reply' }).click();
    await expect(page.getByTestId('comment')).toHaveCount(1);
    await expect(page.getByLabel('Reply')).toHaveValue('');
  });

  test('rejects an empty reply without calling the server', async ({ page }) => {
    const api = await installMockApi(page);
    api.seedTickets(1);
    await signInAsEmployee(page);
    await page.getByRole('link', { name: 'Seeded ticket 1' }).click();
    await page.getByRole('button', { name: 'Send reply' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toHaveText('Enter a reply.');
    await expect(page.getByLabel('Reply')).toBeFocused();
    expect(api.tickets()[0]!.comments).toHaveLength(0);
  });
});

test.describe('layout', () => {
  test('never scrolls the whole page sideways on any employee screen', async ({ page }) => {
    const api = await installMockApi(page);
    const [t] = api.seedTickets(12);
    api.technician.reply(t!.id, 'A reply '.repeat(80));
    await signInAsEmployee(page);

    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.goto('/employee/tickets/new');
    await expect(page.getByRole('heading', { level: 1, name: 'New ticket' })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.goto(`/employee/tickets/${t!.id}?created=1`);
    await expect(page.getByTestId('tracking-id')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
});
