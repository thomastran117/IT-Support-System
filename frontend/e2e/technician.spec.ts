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
  await expect(page.getByLabel('Category')).toHaveValue('c0000000-0000-4000-8000-000000000002');
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

// --- AI suggestions (SD-027): review controls, side by side with the approved values ---------

const card = (page: Page) => page.getByRole('region', { name: 'AI suggestions' });
const suggested = (page: Page, field: string) => page.getByTestId(`suggested-${field}`);
const approvedCell = (page: Page, field: string) => page.getByTestId(`approved-${field}`);

async function openWithSuggestion(
  page: Page,
  proposal: { category?: string; team?: string; priority?: string } = {
    category: 'Hardware',
    team: 'Network & Access',
    priority: 'HIGH',
  },
) {
  const api = await installMockApi(page);
  const [t] = api.seedTickets(1);
  api.technician.suggest(t!.id, proposal);
  await signInAsTechnician(page);
  await openTicket(page, t!.title);
  return { api, ticket: t! };
}

test('a pending suggestion is labelled and shown beside the approved values', async ({ page }) => {
  await openWithSuggestion(page);
  await expect(card(page).getByText('AI suggestion — requires review')).toBeVisible();
  await expect(suggested(page, 'category')).toHaveText('Hardware');
  await expect(suggested(page, 'priority')).toHaveText('High');
  await expect(suggested(page, 'team')).toHaveText('Network & Access');
  // Nothing is approved yet: the suggestion has not changed the ticket.
  await expect(approvedCell(page, 'category')).toHaveText('Not set');
  await expect(approvedCell(page, 'priority')).toHaveText('Not set yet');
  await expect(approvedCell(page, 'team')).toHaveText('Not assigned');
  await expect(card(page)).toContainText('Model-reported confidence 82% (not a probability)');
  await expect(statusLine(page)).toHaveText('Open');
});

test('accepting applies the suggestion and records who decided', async ({ page }) => {
  const { api, ticket } = await openWithSuggestion(page);
  await card(page).getByLabel('Review notes (optional)').fill('Matches the symptoms.');
  await card(page).getByRole('button', { name: 'Accept suggestion' }).click();
  await expect(notice(page)).toHaveText('AI suggestion accepted.');
  await expect(statusLine(page)).toHaveText('Triaged');
  await expect(approvedCell(page, 'category')).toContainText('Hardware');
  await expect(approvedCell(page, 'priority')).toContainText('High');
  await expect(approvedCell(page, 'team')).toContainText('Network & Access');
  await expect(card(page).getByTestId('review-outcome')).toContainText(
    'Accepted by Tara Technician',
  );
  await expect(card(page).getByTestId('review-outcome')).toContainText('Matches the symptoms.');
  // The decision is final: no second set of buttons, and the routing form followed the server.
  await expect(card(page).getByRole('button', { name: 'Accept suggestion' })).toHaveCount(0);
  await expect(page.getByLabel('Team', { exact: true })).toHaveValue('t-net');
  expect(api.tickets().find((x) => x.id === ticket.id)!.recommendations[0]!.review.status).toBe(
    'ACCEPTED',
  );
});

test('overriding applies the technician values and keeps the original suggestion visible', async ({
  page,
}) => {
  await openWithSuggestion(page);
  await card(page).getByRole('button', { name: 'Override…' }).click();
  // The override form starts from the suggestion.
  await expect(page.getByLabel('Override priority')).toHaveValue('HIGH');
  await page.getByLabel('Override priority').selectOption({ label: 'Critical' });
  await page.getByLabel('Override category').selectOption({ label: 'Software' });
  await card(page).getByRole('button', { name: 'Apply override' }).click();
  await expect(notice(page)).toHaveText('AI suggestion overridden.');
  await expect(approvedCell(page, 'priority')).toContainText('Critical');
  await expect(approvedCell(page, 'category')).toContainText('Software');
  await expect(approvedCell(page, 'team')).toContainText('Network & Access');
  // What the AI originally said is still shown, unchanged.
  await expect(suggested(page, 'priority')).toHaveText('High');
  await expect(suggested(page, 'category')).toHaveText('Hardware');
  await expect(card(page).getByTestId('review-outcome')).toContainText(
    'Overridden by Tara Technician',
  );
});

test('rejecting leaves the approved values alone and manual triage stays available', async ({
  page,
}) => {
  await openWithSuggestion(page);
  await card(page).getByRole('button', { name: 'Reject suggestion' }).click();
  await expect(notice(page)).toHaveText('AI suggestion rejected.');
  await expect(statusLine(page)).toHaveText('Open');
  await expect(approvedCell(page, 'category')).toHaveText('Not set');
  await expect(card(page).getByTestId('review-outcome')).toContainText(
    'Rejected by Tara Technician',
  );
  // The technician carries on by hand.
  await approve(page);
  await page.getByRole('button', { name: 'Approve routing' }).click();
  await expect(notice(page)).toHaveText('Routing approved.');
  await expect(statusLine(page)).toHaveText('Triaged');
});

test('a double click reviews once', async ({ page }) => {
  await openWithSuggestion(page);
  const reviews: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/review')) reviews.push(r.url());
  });
  await card(page).getByRole('button', { name: 'Accept suggestion' }).dblclick();
  await expect(notice(page)).toHaveText('AI suggestion accepted.');
  expect(reviews).toHaveLength(1);
});

test('a suggestion pointing at an inactive team cannot be accepted, only overridden or rejected', async ({
  page,
}) => {
  const api = await installMockApi(page);
  const [t] = api.seedTickets(1);
  api.technician.suggest(t!.id, {
    category: 'Hardware',
    team: 'Network & Access',
    priority: 'LOW',
  });
  api.technician.deactivate('team', 'Network & Access');
  await signInAsTechnician(page);
  await openTicket(page, t!.title);
  await expect(card(page)).toContainText('The suggested team is no longer active.');
  await expect(card(page).getByRole('button', { name: 'Accept suggestion' })).toBeDisabled();
  await expect(card(page).getByRole('button', { name: 'Reject suggestion' })).toBeEnabled();
  await card(page).getByRole('button', { name: 'Override…' }).click();
  await page.getByLabel('Override team').selectOption({ label: 'Hardware & Devices' });
  await card(page).getByRole('button', { name: 'Apply override' }).click();
  // The override was saved. Hardware is not one of Tara's teams, so the ticket is handed over.
  await expect(page.getByRole('heading', { level: 1, name: 'Ticket handed over' })).toBeVisible();
  await expect(page.getByText('AI suggestion overridden.')).toBeVisible();
  expect(api.tickets()[0]!.team?.id).toBe('t-hw');
});

test('a ticket changed elsewhere gives a conflict, then the review succeeds on the fresh version', async ({
  page,
}) => {
  const { api, ticket } = await openWithSuggestion(page);
  api.technician.reply(ticket.id, 'Someone else added a note.', true);
  await card(page).getByRole('button', { name: 'Accept suggestion' }).click();
  await expect(notice(page)).toContainText('Someone else changed this ticket');
  await expect(card(page).getByText('AI suggestion — requires review')).toBeVisible();
  await card(page).getByRole('button', { name: 'Accept suggestion' }).click();
  await expect(notice(page)).toHaveText('AI suggestion accepted.');
});

test('a suggestion someone else already reviewed is shown as decided', async ({ page }) => {
  const { api, ticket } = await openWithSuggestion(page);
  const rec = api.tickets().find((x) => x.id === ticket.id)!.recommendations[0]!;
  rec.review = {
    status: 'REJECTED',
    reviewer: { id: 'u-tom', name: 'Tom Technician' },
    reviewedAt: new Date().toISOString(),
    notes: null,
  };
  await card(page).getByRole('button', { name: 'Reject suggestion' }).click();
  await expect(notice(page)).toContainText('changed by someone else');
  await expect(card(page).getByTestId('review-outcome')).toContainText(
    'Rejected by Tom Technician',
  );
  await expect(card(page).getByRole('button', { name: 'Reject suggestion' })).toHaveCount(0);
});

test('a load failure never blocks manual triage and can be retried', async ({ page }) => {
  const api = await installMockApi(page);
  const [t] = api.seedTickets(1);
  api.technician.suggest(t!.id, {
    category: 'Hardware',
    team: 'Network & Access',
    priority: 'HIGH',
  });
  api.failNext('recs', 500);
  await signInAsTechnician(page);
  await openTicket(page, t!.title);
  await expect(card(page).getByRole('alert')).toContainText('AI suggestions could not be loaded');
  // The rest of the page is fully usable while suggestions are unavailable.
  await expect(page.getByLabel('Category')).toBeEnabled();
  await card(page).getByRole('button', { name: 'Try again' }).click();
  await expect(card(page).getByText('AI suggestion — requires review')).toBeVisible();
});

test('manual routing works while suggestions are unavailable', async ({ page }) => {
  const api = await installMockApi(page);
  const [t] = api.seedTickets(1);
  api.failNext('recs', 500);
  await signInAsTechnician(page);
  await openTicket(page, t!.title);
  await expect(card(page).getByRole('alert')).toBeVisible();
  await approve(page);
  await page.getByRole('button', { name: 'Approve routing' }).click();
  await expect(notice(page)).toHaveText('Routing approved.');
  await expect(statusLine(page)).toHaveText('Triaged');
});

test('re-analysis adds a new suggestion without replacing accepted routing; history stays visible', async ({
  page,
}) => {
  const { api, ticket } = await openWithSuggestion(page);
  await card(page).getByRole('button', { name: 'Accept suggestion' }).click();
  await expect(notice(page)).toHaveText('AI suggestion accepted.');

  api.technician.suggest(ticket.id, {
    category: 'Software',
    team: 'Network & Access',
    priority: 'LOW',
  });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: ticket.title })).toBeVisible();

  // The approved routing is unchanged; the newer suggestion waits for a decision.
  await expect(approvedCell(page, 'category')).toContainText('Hardware');
  await expect(approvedCell(page, 'priority')).toContainText('High');
  await expect(suggested(page, 'category')).toHaveText('Software');
  await expect(card(page).getByText('AI suggestion — requires review')).toBeVisible();

  await card(page).getByText('Earlier suggestions (1)').click();
  const earlier = card(page).getByTestId('earlier-suggestion');
  await expect(earlier).toHaveCount(1);
  await expect(earlier).toContainText('Accepted');
  await expect(earlier).toContainText('Tara Technician');
});

test('a resolved ticket can still reject a suggestion but not apply it', async ({ page }) => {
  const api = await installMockApi(page);
  const [t] = api.seedTickets(1);
  api.technician.update(t!.id, {
    category: 'Hardware',
    priority: 'HIGH',
    team: 'Network & Access',
    status: 'RESOLVED',
  });
  api.technician.suggest(t!.id, {
    category: 'Software',
    team: 'Network & Access',
    priority: 'LOW',
  });
  await signInAsTechnician(page);
  await page.goto(`/technician/tickets/${t!.id}`);
  await expect(card(page).getByText('so a suggestion cannot change its routing')).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Accept suggestion' })).toBeDisabled();
  await expect(card(page).getByRole('button', { name: 'Override…' })).toBeDisabled();
  await card(page).getByRole('button', { name: 'Reject suggestion' }).click();
  await expect(notice(page)).toHaveText('AI suggestion rejected.');
});

// --- AI analysis job (SD-038): request, queued/running/failed states and the manual fallback -----

const panel = (page: Page) => card(page).getByTestId('analysis-panel');

async function openPlain(page: Page) {
  const api = await installMockApi(page);
  const [t] = api.seedTickets(1);
  await signInAsTechnician(page);
  await openTicket(page, t!.title);
  return { api, ticket: t! };
}

test('request an analysis, watch it run, and review the suggestion it produces', async ({
  page,
}) => {
  const { api, ticket } = await openPlain(page);
  await expect(panel(page).getByRole('button', { name: 'Request analysis' })).toBeVisible();

  await panel(page).getByRole('button', { name: 'Request analysis' }).click();
  await expect(panel(page).getByTestId('analysis-state')).toContainText('AI analysis is queued');
  await expect(panel(page).getByRole('button')).toHaveCount(0);
  expect(api.analysisRequests()).toHaveLength(1);
  expect(api.analysisRequests()[0]).toMatch(/^[0-9a-f-]{36}$/);

  api.technician.setAnalysis(ticket.id, { state: 'RUNNING', attempts: 1, maxAttempts: 3 });
  await expect(panel(page).getByTestId('analysis-state')).toContainText('AI analysis is running');

  api.technician.finishAnalysis(ticket.id, {
    category: 'Hardware',
    team: 'Network & Access',
    priority: 'HIGH',
  });
  // The page notices on its own: no reload needed.
  await expect(card(page).getByText('AI suggestion — requires review')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Re-analyse' })).toBeVisible();
  await expect(panel(page)).toContainText('never changes the approved routing');

  await card(page).getByRole('button', { name: 'Accept suggestion' }).click();
  await expect(notice(page)).toHaveText('AI suggestion accepted.');
});

test('double clicking "Request analysis" sends one request', async ({ page }) => {
  const { api } = await openPlain(page);
  await panel(page).getByRole('button', { name: 'Request analysis' }).dblclick();
  await expect(panel(page).getByTestId('analysis-state')).toContainText('queued');
  expect(api.analysisRequests()).toHaveLength(1);
});

test('a failed analysis is explained, offers a retry and never blocks manual triage', async ({
  page,
}) => {
  const { api, ticket } = await openPlain(page);
  api.technician.setAnalysis(ticket.id, {
    state: 'FAILED',
    requestId: '00000000-0000-4000-8000-000000000001',
    attempts: 3,
    maxAttempts: 3,
    failure: { reason: 'provider_unavailable', message: 'The AI service was unavailable.' },
  });
  await page.reload();

  const state = panel(page).getByTestId('analysis-state');
  await expect(state).toContainText('AI analysis failed');
  await expect(state).toContainText('The AI service was unavailable.');
  await expect(state).toContainText('Tried 3 times. No suggestion was created.');
  await expect(card(page).getByTestId('ai-note')).toContainText('no AI suggestion');

  // Manual routing works while AI is down.
  await approve(page);
  await page.getByRole('button', { name: 'Approve routing' }).click();
  await expect(notice(page)).toHaveText('Routing approved.');

  // A technician retry starts a fresh analysis, which then completes normally.
  await panel(page).getByRole('button', { name: 'Try analysis again' }).click();
  await expect(panel(page).getByTestId('analysis-state')).toContainText('queued');
  expect(api.analysisRequests()).toHaveLength(1);
  api.technician.finishAnalysis(ticket.id, {
    category: 'Software',
    team: 'Network & Access',
    priority: 'LOW',
  });
  await expect(card(page).getByText('AI suggestion — requires review')).toBeVisible();
  await expect(panel(page).getByTestId('analysis-state')).toHaveCount(0);
});

test('a transient failure shows the reason, the attempt and when it will retry', async ({
  page,
}) => {
  const { api, ticket } = await openPlain(page);
  api.technician.setAnalysis(ticket.id, {
    state: 'QUEUED',
    requestId: '00000000-0000-4000-8000-000000000002',
    attempts: 1,
    maxAttempts: 3,
    retryAt: '2030-01-01T10:00:00.000Z',
    failure: { reason: 'rate_limited', message: 'The AI service is busy.' },
  });
  await page.reload();
  const state = panel(page).getByTestId('analysis-state');
  await expect(state).toContainText('the AI service was busy');
  await expect(state).toContainText('attempt 1 of 3');
  await expect(state).toContainText('Manual routing is not affected.');
});

test('when AI is switched off the card says so and offers no analysis', async ({ page }) => {
  const api = await installMockApi(page);
  api.setAiEnabled(false);
  const [t] = api.seedTickets(1);
  await signInAsTechnician(page);
  await openTicket(page, t!.title);
  await expect(panel(page).getByTestId('analysis-state')).toContainText(
    'AI analysis is switched off',
  );
  await expect(panel(page).getByRole('button')).toHaveCount(0);
  await approve(page);
  await page.getByRole('button', { name: 'Approve routing' }).click();
  await expect(notice(page)).toHaveText('Routing approved.');
});

test('the hourly limit disables the button and explains why', async ({ page }) => {
  const api = await installMockApi(page);
  api.limitAnalysis(true);
  const [t] = api.seedTickets(1);
  await signInAsTechnician(page);
  await openTicket(page, t!.title);
  await expect(panel(page).getByRole('button', { name: 'Request analysis' })).toBeDisabled();
  await expect(panel(page).getByTestId('analysis-limit')).toContainText('hourly analysis limit');
});

test('an analysis someone else already started is reported, and the state catches up', async ({
  page,
}) => {
  const { api, ticket } = await openPlain(page);
  // Another technician queues one after this page loaded.
  api.technician.setAnalysis(ticket.id, {
    state: 'QUEUED',
    requestId: '00000000-0000-4000-8000-000000000003',
    attempts: 0,
    maxAttempts: 3,
  });
  await panel(page).getByRole('button', { name: 'Request analysis' }).click();
  await expect(panel(page).getByTestId('analysis-notice')).toContainText('already running');
  await expect(panel(page).getByTestId('analysis-state')).toContainText('queued');
});

test('a status load failure is retryable and does not block triage', async ({ page }) => {
  const api = await installMockApi(page);
  const [t] = api.seedTickets(1);
  api.failNext('analysis', 500);
  await signInAsTechnician(page);
  await openTicket(page, t!.title);
  await expect(card(page).getByRole('status')).toContainText('status could not be loaded');
  await expect(page.getByLabel('Category')).toBeEnabled();
  await card(page).getByRole('button', { name: 'Check again' }).click();
  await expect(panel(page).getByRole('button', { name: 'Request analysis' })).toBeVisible();
});

test('a request that fails is reported without breaking the page', async ({ page }) => {
  const { api } = await openPlain(page);
  api.failNext('analysis', 500);
  await panel(page).getByRole('button', { name: 'Request analysis' }).click();
  await expect(panel(page).getByTestId('analysis-notice')).toContainText('could not be requested');
  await expect(panel(page).getByRole('button', { name: 'Request analysis' })).toBeEnabled();
});

test('a high-risk ticket gets a manual cue that is clearly not AI', async ({ page }) => {
  const api = await installMockApi(page);
  const [t] = api.seedTickets(1);
  (t as { title: string }).title = 'Ransomware note on the file server';
  api.setAiEnabled(false);
  await signInAsTechnician(page);
  await openTicket(page, t!.title);
  const cue = panel(page).getByTestId('manual-cue');
  await expect(cue).toContainText('looks high risk');
  await expect(cue).toContainText('Possible security incident');
  await expect(cue).toContainText('not an AI result');
});
