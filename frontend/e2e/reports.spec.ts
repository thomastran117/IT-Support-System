import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, installMockApi, PASSWORD } from './helpers/mockApi';

async function signIn(page: Page, account: keyof typeof ACCOUNTS) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ACCOUNTS[account].email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${ACCOUNTS[account].portal}$`));
}

async function openReports(page: Page, from: string, to: string) {
  await page.goto(`/admin/reports?from=${from}&to=${to}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
}

const kpi = (page: Page, id: string) => page.getByTestId(`kpi-${id}`);

test('shows the figures for the requested window, with denominators and units', async ({
  page,
}) => {
  const api = await installMockApi(page);
  await signIn(page, 'admin');
  await openReports(page, '2026-03-01', '2026-03-31');

  await expect(kpi(page, 'submitted')).toContainText('4');
  await expect(kpi(page, 'routed')).toContainText('3 of 4');
  await expect(kpi(page, 'avg-routing')).toContainText('20 min'); // (10 + 20 + 30) / 3
  await expect(kpi(page, 'avg-response')).toContainText('62.5 min'); // (35 + 90) / 2
  await expect(kpi(page, 'avg-response')).toContainText('2 of 4 answered');
  await expect(kpi(page, 'resolved')).toContainText('1');
  await expect(kpi(page, 'avg-resolution')).toContainText('12 h');

  // The request is a half-open UTC window: the end is the day after the last chosen day.
  expect(api.reportRequests().at(-1)).toEqual({
    start: '2026-03-01T00:00:00.000Z',
    end: '2026-04-01T00:00:00.000Z',
  });

  const categories = page.getByRole('table', { name: 'Tickets by category' });
  await expect(categories.getByRole('row', { name: /Hardware\s+2/ })).toBeVisible();
  await expect(categories.getByRole('row', { name: /Software\s+1/ })).toBeVisible();

  await page.getByText('Show the daily figures as a table').click();
  const daily = page.getByRole('table', { name: 'Daily ticket intake' });
  await expect(daily.getByRole('row')).toHaveCount(32); // header + 31 zero-filled days
  await expect(daily.getByRole('row', { name: /2026-03-02\s+2/ })).toBeVisible();
  await expect(daily.getByRole('row', { name: /2026-03-03\s+0/ })).toBeVisible();
});

test('changing the dates re-fetches and changes the cards and charts', async ({ page }) => {
  const api = await installMockApi(page);
  await signIn(page, 'admin');
  await openReports(page, '2026-03-01', '2026-03-31');
  await expect(kpi(page, 'submitted')).toContainText('4');

  await page.getByLabel('To (UTC, inclusive)').fill('2026-03-02');
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(page).toHaveURL(/from=2026-03-01&to=2026-03-02/);
  await expect(kpi(page, 'submitted')).toContainText('2');
  await expect(kpi(page, 'avg-routing')).toContainText('15 min'); // (10 + 20) / 2
  await expect(kpi(page, 'resolved')).toContainText('0');
  expect(api.reportRequests().at(-1)?.end).toBe('2026-03-03T00:00:00.000Z');
});

test('an empty window is explained and undefined averages read N/A, not 0', async ({ page }) => {
  await installMockApi(page);
  await signIn(page, 'admin');
  await openReports(page, '2026-05-01', '2026-05-31');

  await expect(page.getByText('No tickets in this period', { exact: true })).toBeVisible();
  await expect(kpi(page, 'submitted')).toContainText('0');
  for (const id of [
    'avg-routing',
    'avg-response',
    'avg-resolution',
    'ai-accuracy',
    'ai-acceptance',
  ]) {
    await expect(kpi(page, id)).toContainText('N/A');
    await expect(kpi(page, id)).not.toContainText(/\b0(\.\d+)?\s?(%|min|h)/);
  }
  await expect(page.getByText('No tickets in this period.', { exact: true })).toBeVisible();
});

test('an invalid range is explained and not sent to the server', async ({ page }) => {
  const api = await installMockApi(page);
  await signIn(page, 'admin');
  await openReports(page, '2026-03-01', '2026-03-31');
  const before = api.reportRequests().length;

  await page.getByLabel('From (UTC)').fill('2026-04-10');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('on or before');
  await expect(page.getByRole('button', { name: 'Apply' })).toBeDisabled();
  expect(api.reportRequests().length).toBe(before);
});

test('an error offers a retry that recovers', async ({ page }) => {
  const api = await installMockApi(page);
  await signIn(page, 'admin');
  api.failNext('report', 500);
  await openReports(page, '2026-03-01', '2026-03-31');

  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Unable to load the report',
  );
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(kpi(page, 'submitted')).toContainText('4');
});

test('the range survives navigating away and back', async ({ page }) => {
  await installMockApi(page);
  await signIn(page, 'admin');
  await openReports(page, '2026-03-01', '2026-03-02');
  await expect(kpi(page, 'submitted')).toContainText('2');

  const nav = async (name: string) => {
    const menu = page.getByRole('button', { name: 'Open navigation' });
    if (await menu.isVisible()) {
      await menu.click();
      await page.getByRole('dialog', { name: 'Navigation' }).getByRole('link', { name }).click();
    } else {
      await page.getByRole('link', { name }).first().click();
    }
  };
  await nav('User management');
  await expect(page.getByRole('heading', { level: 1, name: 'Admin area' })).toBeVisible();
  await nav('Reports');

  await expect(page).toHaveURL(/from=2026-03-01&to=2026-03-02/);
  await expect(page.getByLabel('From (UTC)')).toHaveValue('2026-03-01');
  await expect(kpi(page, 'submitted')).toContainText('2');
});

test('employees and technicians cannot open the report page or read its data', async ({ page }) => {
  const api = await installMockApi(page);
  await signIn(page, 'employee');
  await page.goto('/admin/reports?from=2026-03-01&to=2026-03-31');
  await expect(page).toHaveURL(/\/employee$/);
  await expect(page.getByTestId('kpi-submitted')).toHaveCount(0);
  expect(api.reportRequests()).toHaveLength(0);

  // Even a direct call is refused by the API.
  const status = await page.evaluate(async () => {
    const res = await fetch('/api/admin/reports/summary?start=2026-03-01&end=2026-04-01');
    return res.status;
  });
  expect(status).toBe(403);

  const second = await page.context().newPage();
  await installMockApi(second);
  await signIn(second, 'technician');
  await second.goto('/admin/reports');
  await expect(second).toHaveURL(/\/technician$/);
});

test('the dashboard fits a phone screen without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await installMockApi(page);
  await signIn(page, 'admin');
  await openReports(page, '2026-03-01', '2026-03-31');
  await expect(kpi(page, 'submitted')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
