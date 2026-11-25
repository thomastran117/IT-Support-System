import { expect, test, type Page } from '@playwright/test';

/**
 * LIVE end-to-end suite (SD-055): a real browser -> gateway -> isolated services -> PostgreSQL on
 * the disposable SD-100 Compose stack with the fake AI provider. It runs only from
 * `docker/verify-ticket-service.sh` (SD100=1). The other e2e specs mock the API with
 * `installMockApi`; they are UI tests, not integrated journeys.
 */
test.skip(process.env.E2E_MICROSERVICE !== 'true', 'Requires the isolated Compose stack');
test.use({ actionTimeout: 10_000 });

/** Set by the gate while the AI service is stopped; only the @ai-outage journey runs then. */
const aiStopped = process.env.E2E_AI_STOPPED === 'true';

type Account = 'erin' | 'omar' | 'tara' | 'hana' | 'admin';

async function signIn(page: Page, name: Account, portal: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`${name}@smartdesk.test`);
  await page.getByLabel('Password').fill('SmartDesk-Demo-1!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`/${portal}$`));
}

/** A report window around now, so tickets created by this run fall inside it. */
function todayWindow() {
  const day = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return `from=${iso(Date.now() - day)}&to=${iso(Date.now() + day)}`;
}

async function submittedCount(admin: Page) {
  await admin.goto(`/admin/reports?${todayWindow()}`);
  await expect(admin.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
  const value = admin.getByTestId('kpi-submitted').locator('dd > span').first();
  await expect(value).toHaveText(/^\d+$/);
  return Number(await value.innerText());
}

async function submitTicket(employee: Page, title: string, description: string) {
  await employee.getByRole('link', { name: 'New ticket' }).first().click();
  await employee.getByLabel('Title').fill(title);
  await employee.getByLabel('Description').fill(description);
  await employee.getByRole('button', { name: 'Submit ticket' }).click();
  await expect(employee.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  const ticketId = await employee.getByTestId('tracking-id').innerText();
  expect(ticketId).toMatch(/^[0-9a-f-]{36}$/);
  return ticketId;
}

async function chooseRouting(technician: Page, priority = 'High', team = 'Network & Access') {
  await technician.getByLabel('Category', { exact: true }).selectOption({ label: 'Network/VPN' });
  await technician.getByLabel('Priority', { exact: true }).selectOption({ label: priority });
  await technician.getByLabel('Team', { exact: true }).selectOption({ label: team });
}

const notice = (page: Page) => page.getByTestId('notice');
const suggestions = (page: Page) => page.getByRole('region', { name: 'AI suggestions' });

test('employee, technician, and administrator use the isolated services through the gateway', async ({
  page: employee,
  browser,
  baseURL,
}) => {
  test.skip(aiStopped, 'Runs with every service up');
  test.setTimeout(90_000);
  const technicianContext = await browser.newContext({ baseURL });
  const adminContext = await browser.newContext({ baseURL });
  technicianContext.setDefaultTimeout(10_000);
  adminContext.setDefaultTimeout(10_000);
  try {
    await signIn(employee, 'erin', 'employee');
    expect(await employee.evaluate(() => window.isSecureContext)).toBe(true);
    await employee.reload();
    await expect(employee.getByRole('heading', { name: 'My tickets', level: 1 })).toBeVisible();

    const admin = await adminContext.newPage();
    await signIn(admin, 'admin', 'admin');
    const submittedBefore = await submittedCount(admin);

    const title = 'Isolated browser VPN ticket';
    const ticketId = await submitTicket(
      employee,
      title,
      'The VPN disconnects when switching networks.',
    );

    const technician = await technicianContext.newPage();
    await signIn(technician, 'tara', 'technician');
    await technician.goto(`/technician/tickets/${ticketId}`);
    await expect(technician.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await chooseRouting(technician);
    await technician.getByLabel('Assignee').selectOption({ label: 'Tara Technician' });
    await technician.getByRole('button', { name: 'Approve routing' }).click();
    await expect(notice(technician)).toHaveText('Routing approved.');
    await technician.getByRole('button', { name: 'Start work' }).click();
    await expect(employee.locator('[aria-current="step"]')).toContainText('In progress', {
      timeout: 15_000,
    });

    const privateNote = 'Isolated browser staff-only note';
    await technician.getByLabel('Add a note or reply').fill(privateNote);
    await technician.getByRole('button', { name: 'Add internal note' }).click();
    await expect(technician.getByTestId('comment').filter({ hasText: privateNote })).toBeVisible();
    const publicReply = 'The VPN profile was refreshed.';
    await technician.getByLabel(/Internal note \(staff only/).uncheck();
    await technician.getByLabel('Add a note or reply').fill(publicReply);
    await technician.getByRole('button', { name: 'Send reply' }).click();
    await expect(employee.getByTestId('comment').filter({ hasText: publicReply })).toBeVisible({
      timeout: 15_000,
    });
    await expect(employee.getByTestId('comment').filter({ hasText: privateNote })).toHaveCount(0);
    await technician.getByLabel('Resolution summary').fill('Updated the VPN profile.');
    await technician.getByRole('button', { name: 'Resolve', exact: true }).click();
    await expect(employee.locator('[aria-current="step"]')).toContainText('Resolved', {
      timeout: 15_000,
    });
    await expect(employee.getByText('Updated the VPN profile.')).toBeVisible();

    await employee.getByRole('button', { name: /^Notifications/ }).click();
    const inbox = employee.getByRole('dialog', { name: 'Notifications' });
    await expect(inbox.locator(`a[href="/employee/tickets/${ticketId}"]`).first()).toBeVisible({
      timeout: 15_000,
    });

    // Analytics reads the committed ticket: exactly one more submission in today's window.
    expect(await submittedCount(admin)).toBe(submittedBefore + 1);
    await admin.goto('/admin/knowledge');
    await expect(admin.getByRole('heading', { name: /knowledge/i, level: 1 })).toBeVisible();
    await expect(admin.getByText(/VPN/i).first()).toBeVisible();
  } finally {
    await Promise.allSettled([technicianContext.close(), adminContext.close()]);
  }
});

test('technician reviews the AI suggestion, a stale tab gets a conflict, and roles stay isolated', async ({
  page: employee,
  browser,
  baseURL,
}) => {
  test.skip(aiStopped, 'Needs the AI service');
  test.setTimeout(120_000);
  const technicianContext = await browser.newContext({ baseURL });
  const otherEmployeeContext = await browser.newContext({ baseURL });
  technicianContext.setDefaultTimeout(10_000);
  otherEmployeeContext.setDefaultTimeout(10_000);
  try {
    await signIn(employee, 'erin', 'employee');
    const title = 'Isolated browser AI review ticket';
    const ticketId = await submitTicket(
      employee,
      title,
      'VPN keeps dropping after the client update on the office network.',
    );

    // Another employee cannot open the ticket or reach the staff portals.
    const omar = await otherEmployeeContext.newPage();
    await signIn(omar, 'omar', 'employee');
    await omar.goto(`/employee/tickets/${ticketId}`);
    await expect(omar.getByRole('heading', { level: 1, name: 'Ticket not found' })).toBeVisible();
    await expect(omar.getByText(title)).toHaveCount(0);
    for (const portal of ['/technician', '/admin', `/technician/tickets/${ticketId}`]) {
      await omar.goto(portal);
      await expect(omar).toHaveURL(/\/employee$/);
    }

    // Two tabs on the same ticket. The fake provider's suggestion arrives without a reload. It
    // always proposes the first allowed team (Hardware & Devices), so Hana, a member, reviews it.
    const technician = await technicianContext.newPage();
    await signIn(technician, 'hana', 'technician');
    await technician.goto(`/technician/tickets/${ticketId}`);
    const stale = await technicianContext.newPage();
    await stale.goto(`/technician/tickets/${ticketId}`);
    await expect(stale.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await expect(suggestions(technician).getByText('AI suggestion — requires review')).toBeVisible({
      timeout: 45_000,
    });
    await suggestions(technician).getByRole('button', { name: 'Accept suggestion' }).click();
    await expect(notice(technician)).toContainText('AI suggestion accepted.');

    // The stale tab still holds the old version: its write is refused, then succeeds on reload.
    await chooseRouting(stale, 'Critical', 'Hardware & Devices');
    await stale.getByRole('button', { name: 'Approve routing' }).click();
    await expect(notice(stale)).toContainText('Someone else changed this ticket');
    // The reloaded ticket is already triaged by the accepted suggestion, so this is an edit.
    await chooseRouting(stale, 'Critical', 'Hardware & Devices');
    await stale.getByRole('button', { name: 'Save routing' }).click();
    await expect(notice(stale)).toHaveText('Routing approved.');
    await expect(stale.getByLabel('Priority', { exact: true })).toHaveValue('CRITICAL');
  } finally {
    await Promise.allSettled([technicianContext.close(), otherEmployeeContext.close()]);
  }
});

test('@ai-outage the manual workflow completes in the browser while AI is stopped', async ({
  page: employee,
  browser,
  baseURL,
}) => {
  test.skip(!aiStopped, 'The gate runs this after stopping the AI service');
  test.setTimeout(90_000);
  const technicianContext = await browser.newContext({ baseURL });
  technicianContext.setDefaultTimeout(10_000);
  try {
    await signIn(employee, 'erin', 'employee');
    const title = 'Isolated browser ticket during AI outage';
    const ticketId = await submitTicket(employee, title, 'The VPN client will not connect.');

    const technician = await technicianContext.newPage();
    await signIn(technician, 'tara', 'technician');
    await technician.goto(`/technician/tickets/${ticketId}`);
    await expect(technician.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    // No suggestion can arrive while AI is down, and nothing blocks manual triage.
    await expect(suggestions(technician).getByTestId('analysis-state')).toContainText(/queued/i);
    await expect(suggestions(technician).getByText('AI suggestion — requires review')).toHaveCount(
      0,
    );
    await chooseRouting(technician);
    await technician.getByLabel('Assignee').selectOption({ label: 'Tara Technician' });
    await technician.getByRole('button', { name: 'Approve routing' }).click();
    await expect(notice(technician)).toHaveText('Routing approved.');
    await technician.getByRole('button', { name: 'Start work' }).click();
    await expect(employee.locator('[aria-current="step"]')).toContainText('In progress', {
      timeout: 15_000,
    });
    await technician.getByLabel('Resolution summary').fill('Reinstalled the VPN client manually.');
    await technician.getByRole('button', { name: 'Resolve', exact: true }).click();
    await expect(employee.locator('[aria-current="step"]')).toContainText('Resolved', {
      timeout: 15_000,
    });
  } finally {
    await technicianContext.close();
  }
});
