import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, installMockApi, PASSWORD } from './helpers/mockApi';

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function signInAsTechnician(page: Page) {
  await signIn(page, ACCOUNTS.technician.email);
  await expect(page.getByRole('heading', { level: 1, name: 'Technician dashboard' })).toBeVisible();
}

/** Open a ticket from the dashboard and wait for it, so form controls are not confused with filters. */
async function openTicket(page: Page, title: string) {
  await page.getByRole('link', { name: title }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

const notice = (page: Page) => page.getByTestId('notice');
const statusLine = (page: Page) =>
  page.locator('header').getByText(/^(Open|Triaged|In progress|Resolved|Closed)$/);

async function approve(page: Page, over: { priority?: string; team?: string } = {}) {
  await page.getByLabel('Category').selectOption({ label: 'Hardware' });
  await page.getByLabel('Priority').selectOption({ label: over.priority ?? 'High' });
  await page.getByLabel('Team').selectOption({ label: over.team ?? 'Network & Access' });
}

test('manual journey with no AI: pick from the backlog, triage, work, resolve and reopen', async ({
  page,
}) => {
  const api = await installMockApi(page);
  const [first] = api.seedTickets(3);
  await signInAsTechnician(page);

  // The unassigned backlog lists every OPEN ticket with its age.
  const rows = page.getByRole('row').filter({ hasText: 'Seeded ticket' });
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('Not set yet');
  await expect(rows.first()).toContainText('Unassigned');
  await expect(rows.first()).toContainText(/\d+ min/);
  await expect(page.getByText('Showing 1–3 of 3')).toBeVisible();

  // Open one; nothing is approved yet and AI is not required.
  await rows.filter({ hasText: first!.title }).getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1, name: first!.title })).toBeVisible();
  await expect(page.getByTestId('ai-note')).toContainText('Manual routing never depends');
  await expect(page.getByText('Approve the routing above')).toBeVisible();

  // Incomplete routing is refused before any request is made.
  await page.getByRole('button', { name: 'Approve routing' }).click();
  await expect(notice(page)).toContainText('Choose a category, priority and team');

  // Approve category, priority, team and assignee in one step. The team's members are offered.
  await approve(page);
  await expect(page.getByLabel('Assignee').locator('option')).toHaveText([
    'Unassigned',
    'Tara Technician',
    'Tom Technician',
  ]);
  await page.getByLabel('Assignee').selectOption({ label: 'Tara Technician' });
  await page.getByRole('button', { name: 'Approve routing' }).click();
  await expect(notice(page)).toHaveText('Routing approved.');
  await expect(statusLine(page)).toHaveText('Triaged');
  await expect(page.getByLabel('Assignee')).toHaveValue('u-tara');
  await expect(
    page.getByTestId('timeline-entry').filter({ hasText: 'assigned a support team' }),
  ).toHaveCount(1);

  // Start work, then try to resolve without a summary.
  await page.getByRole('button', { name: 'Start work' }).click();
  await expect(statusLine(page)).toHaveText('In progress');
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('Enter a resolution summary')).toBeVisible();
  await expect(statusLine(page)).toHaveText('In progress');

  // Internal note and public reply are labelled differently.
  await page.getByLabel('Add a note or reply').fill('Checked the switch config.');
  await page.getByRole('button', { name: 'Add internal note' }).click();
  await expect(notice(page)).toHaveText('Internal note added.');
  await page.getByLabel('Internal note (staff only').uncheck();
  await page.getByLabel('Add a note or reply').fill('We are on it.');
  await page.getByRole('button', { name: 'Send reply' }).click();
  const comments = page.getByTestId('comment');
  await expect(comments).toHaveCount(2);
  await expect(comments.nth(0)).toContainText('Internal note');
  await expect(comments.nth(1)).not.toContainText('Internal note');

  // Resolve with a summary.
  await page.getByLabel('Resolution summary').fill('Replaced the faulty patch cable.');
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(statusLine(page)).toHaveText('Resolved');
  await expect(page.getByText('Replaced the faulty patch cable.')).toBeVisible();
  // Resolved tickets can no longer be re-routed.
  await expect(page.getByLabel('Category')).toHaveCount(0);

  // Reopen, then hand the ticket to a team this technician does not belong to.
  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect(statusLine(page)).toHaveText('Open');
  await page.getByLabel('Team').selectOption({ label: 'Hardware & Devices' });
  await expect(page.getByLabel('Assignee')).toHaveValue('');
  await page.getByLabel('Assignee').selectOption({ label: 'Hana Technician' });
  await page.getByRole('button', { name: 'Approve routing' }).click();
  // The change is saved, and the page says plainly why the ticket is no longer available.
  await expect(page.getByRole('heading', { level: 1, name: 'Ticket handed over' })).toBeVisible();
  await expect(page.getByText('Routing approved.')).toBeVisible();
  await expect(page.getByText('no longer open it')).toBeVisible();
  expect(api.tickets()[0]!.team?.id).toBe('t-hw');

  // Back on the dashboard the ticket left the backlog.
  await page.getByRole('link', { name: 'Back to the dashboard' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Seeded ticket' })).toHaveCount(2);
});

test('team queue and assigned-to-me are scoped to my team and ordered by priority', async ({
  page,
}) => {
  const api = await installMockApi(page);
  const [a, b, c] = api.seedTickets(3);
  api.technician.update(a!.id, {
    category: 'Hardware',
    priority: 'LOW',
    team: 'Network & Access',
    status: 'TRIAGED',
  });
  api.technician.update(b!.id, {
    category: 'Hardware',
    priority: 'CRITICAL',
    team: 'Network & Access',
    status: 'TRIAGED',
  });
  void c;
  await signInAsTechnician(page);

  await page.getByRole('tab', { name: 'Team queue' }).click();
  // Only my own team is offered.
  await expect(page.getByLabel('Team', { exact: true }).locator('option')).toHaveText([
    'Network & Access',
  ]);
  const rows = page.getByRole('row').filter({ hasText: 'Seeded ticket' });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Critical');
  await expect(rows.nth(1)).toContainText('Low');

  // Filters narrow the list, with an explanatory empty state.
  await page.getByLabel('Priority').selectOption({ label: 'High' });
  await expect(page.getByText('No tickets match these filters.')).toBeVisible();
  await page.getByLabel('Priority').selectOption({ label: 'Critical' });
  await expect(rows).toHaveCount(1);

  // The technician update assigned both to Tara in the mock, so "assigned to me" matches.
  await page.getByLabel('Priority').selectOption({ label: 'All priorities' });
  await page.getByRole('tab', { name: 'Assigned to me' }).click();
  await expect(rows).toHaveCount(2);
});

test('pagination moves through a long backlog', async ({ page }) => {
  const api = await installMockApi(page);
  api.seedTickets(12);
  await signInAsTechnician(page);
  await expect(page.getByText('Showing 1–10 of 12')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Showing 11–12 of 12')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
});

test('a concurrent edit is reported as a conflict and the latest version is loaded', async ({
  page,
}) => {
  const api = await installMockApi(page);
  const [t] = api.seedTickets(1);
  await signInAsTechnician(page);
  await openTicket(page, t!.title);

  await approve(page);
  // Someone else changes the ticket after this page loaded it.
  api.technician.update(t!.id, {
    category: 'Software',
    priority: 'MEDIUM',
    team: 'Network & Access',
  });

  await page.getByRole('button', { name: 'Approve routing' }).click();
  await expect(notice(page)).toContainText('Someone else changed this ticket');
  // The form was reset to what the server now holds, not left half-applied.
  await expect(page.getByLabel('Category')).toHaveValue('c-sw');
  await expect(page.getByLabel('Priority')).toHaveValue('MEDIUM');

  // Re-applying on top of the fresh version succeeds.
  await approve(page, { priority: 'Critical' });
  await page.getByRole('button', { name: 'Approve routing' }).click();
  await expect(notice(page)).toHaveText('Routing approved.');
  await expect(page.getByLabel('Priority')).toHaveValue('CRITICAL');
});

test('a status action on a stale ticket is reported as a conflict and the ticket reloads', async ({
  page,
}) => {
  const api = await installMockApi(page);
  const [t] = api.seedTickets(1);
  await signInAsTechnician(page);
  await openTicket(page, t!.title);
  await approve(page);
  await page.getByRole('button', { name: 'Approve routing' }).click();
  await expect(statusLine(page)).toHaveText('Triaged');

  await page.getByRole('button', { name: 'Start work' }).click();
  await expect(statusLine(page)).toHaveText('In progress');
  // The ticket moved on elsewhere; the stale button now fails cleanly.
  api.technician.update(t!.id, { status: 'RESOLVED', resolutionSummary: 'Done elsewhere.' });
  await page.getByLabel('Resolution summary').fill('My summary');
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(notice(page)).toContainText('Someone else changed this ticket');
  await expect(statusLine(page)).toHaveText('Resolved');
});

test('the queue reports a load failure and recovers on retry', async ({ page }) => {
  const api = await installMockApi(page);
  api.seedTickets(1);
  api.failNext('queue', 500);
  await signInAsTechnician(page);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Unable to load the queue');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Seeded ticket' })).toHaveCount(1);
});

test('a ticket that belongs to another team is unavailable', async ({ page }) => {
  const api = await installMockApi(page);
  const [t] = api.seedTickets(1);
  api.technician.update(t!.id, {
    category: 'Hardware',
    priority: 'HIGH',
    team: 'Hardware & Devices',
  });

  await signInAsTechnician(page);
  await page.goto(`/technician/tickets/${t!.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Ticket not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to the dashboard' })).toBeVisible();
});

test('an internal note is visible to the technician and never to the requester', async ({
  page,
  isMobile,
}) => {
  const api = await installMockApi(page);
  const [t] = api.seedTickets(1);
  await signInAsTechnician(page);
  await openTicket(page, t!.title);
  await page.getByLabel('Add a note or reply').fill('Customer data was exposed; escalate quietly.');
  await page.getByRole('button', { name: 'Add internal note' }).click();
  await expect(page.getByTestId('comment')).toHaveCount(1);
  await expect(page.getByTestId('comment')).toContainText('Internal note');

  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, ACCOUNTS.employee.email);
  await page.goto(`/employee/tickets/${t!.id}`);
  await expect(page.getByRole('heading', { level: 1, name: t!.title })).toBeVisible();
  await expect(page.getByText('No replies yet.')).toBeVisible();
  await expect(page.getByText('escalate quietly')).toHaveCount(0);
});

test('the technician area is closed to employees', async ({ page }) => {
  await installMockApi(page);
  await signIn(page, ACCOUNTS.employee.email);
  await page.goto('/technician');
  await expect(page.getByRole('heading', { level: 1, name: 'Technician dashboard' })).toHaveCount(
    0,
  );
});
