import { expect, test, type Page } from '@playwright/test';

test.skip(process.env.E2E_MICROSERVICE !== 'true', 'Requires the isolated Compose stack');
test.use({ actionTimeout: 10_000 });

async function signIn(page: Page, name: 'erin' | 'tara' | 'admin', portal: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`${name}@smartdesk.test`);
  await page.getByLabel('Password').fill('SmartDesk-Demo-1!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`/${portal}$`));
}

test('employee, technician, and administrator use the isolated services through the gateway', async ({
  page: employee,
  browser,
  baseURL,
}) => {
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

    const title = 'Isolated browser VPN ticket';
    await employee.getByRole('link', { name: 'New ticket' }).first().click();
    await employee.getByLabel('Title').fill(title);
    await employee.getByLabel('Description').fill('The VPN disconnects when switching networks.');
    await employee.getByRole('button', { name: 'Submit ticket' }).click();
    await expect(employee.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    const ticketId = await employee.getByTestId('tracking-id').innerText();
    expect(ticketId).toMatch(/^[0-9a-f-]{36}$/);

    const technician = await technicianContext.newPage();
    await signIn(technician, 'tara', 'technician');
    await technician.goto(`/technician/tickets/${ticketId}`);
    await expect(technician.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await technician.getByLabel('Category', { exact: true }).selectOption({ label: 'Network/VPN' });
    await technician.getByLabel('Priority', { exact: true }).selectOption({ label: 'High' });
    await technician
      .getByLabel('Team', { exact: true })
      .selectOption({ label: 'Network & Access' });
    await technician.getByLabel('Assignee').selectOption({ label: 'Tara Technician' });
    await technician.getByRole('button', { name: 'Approve routing' }).click();
    await expect(technician.getByTestId('notice')).toHaveText('Routing approved.');
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

    const admin = await adminContext.newPage();
    await signIn(admin, 'admin', 'admin');
    await admin.goto('/admin/reports?from=2026-03-01&to=2026-03-31');
    await expect(admin.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
    await expect(admin.getByTestId('kpi-submitted')).toContainText(/\d/);
    await admin.goto('/admin/knowledge');
    await expect(admin.getByRole('heading', { name: /knowledge/i, level: 1 })).toBeVisible();
    await expect(admin.getByText(/VPN/i).first()).toBeVisible();
  } finally {
    await Promise.allSettled([technicianContext.close(), adminContext.close()]);
  }
});
