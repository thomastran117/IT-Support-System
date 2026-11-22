import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, EVAL_TICKETS, installMockApi, PASSWORD } from './helpers/mockApi';

async function signIn(page: Page, account: keyof typeof ACCOUNTS) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ACCOUNTS[account].email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${ACCOUNTS[account].portal}$`));
}

async function open(page: Page, from = '2026-03-01', to = '2026-03-31') {
  await page.goto(`/admin/evaluation?from=${from}&to=${to}`);
  await expect(page.getByRole('heading', { level: 1, name: 'AI evaluation' })).toBeVisible();
}

const kpi = (page: Page, id: string) => page.getByTestId(`kpi-${id}`);

test('shows accuracy with its denominators, acceptance separately, and the 90% target as unverified', async ({
  page,
}) => {
  await installMockApi(page);
  await signIn(page, 'admin');
  await open(page);

  // 3 labelled: one correct, one wrong, one with no recommendation (kept in the denominator).
  await expect(kpi(page, 'eval-accuracy')).toContainText('33.33%');
  await expect(kpi(page, 'eval-accuracy')).toContainText('1 correct of 3 labelled tickets');
  await expect(kpi(page, 'eval-accuracy')).toContainText('1 had none and count as not correct');
  await expect(kpi(page, 'eval-acceptance')).toContainText('50%');
  await expect(kpi(page, 'eval-acceptance')).toContainText('2 accepted of 4 reviewed');
  await expect(page.getByText('The 90% category-accuracy target is unverified')).toBeVisible();

  const models = page.getByRole('table', { name: 'Accuracy and acceptance by model version' });
  await expect(models.getByRole('row', { name: /model-a\s+2\s+1\s+50%/ })).toBeVisible();

  const confusion = page.getByRole('table', { name: 'Reference versus predicted category' });
  await expect(
    confusion.getByRole('row', { name: /Hardware\s+No valid recommendation\s+1/ }),
  ).toBeVisible();
  await expect(confusion.getByRole('row', { name: /Software\s+Hardware\s+1/ })).toBeVisible();
});

test('an empty window reads N/A and explains itself instead of showing 0%', async ({ page }) => {
  await installMockApi(page);
  await signIn(page, 'admin');
  await open(page, '2026-05-01', '2026-05-31');

  await expect(page.getByText('No independently labelled tickets in this period')).toBeVisible();
  await expect(kpi(page, 'eval-accuracy')).toContainText('N/A');
  await expect(kpi(page, 'eval-accuracy')).not.toContainText('0%');
  await expect(kpi(page, 'eval-acceptance')).toContainText('N/A');
});

test('saving a label records it, refreshes the figures, and never sends who labelled', async ({
  page,
}) => {
  const api = await installMockApi(page);
  await signIn(page, 'admin');
  await open(page);
  await expect(kpi(page, 'eval-accuracy')).toContainText('1 correct of 3');

  await page.getByLabel('Ticket ID').fill(EVAL_TICKETS.printer);
  await page.getByLabel('Reference category').selectOption({ label: 'Software' });
  await page.getByRole('button', { name: 'Save label' }).click();

  await expect(page.getByText('Label saved.')).toBeVisible();
  await expect(kpi(page, 'eval-accuracy')).toContainText('2 correct of 4');
  await expect(kpi(page, 'eval-accuracy')).toContainText('50%');
  const labels = page.getByRole('table', { name: 'Independent labels' });
  await expect(
    labels.getByRole('row', {
      name: new RegExp(`${EVAL_TICKETS.printer}\\s+Software\\s+Alex Admin`),
    }),
  ).toBeVisible();

  expect(api.labelSaves()).toHaveLength(1);
  expect(Object.keys(api.labelSaves()[0]!).sort()).toEqual(['categoryId', 'ticketId']);
});

test('a bad ticket ID is explained locally; a server refusal is shown', async ({ page }) => {
  const api = await installMockApi(page);
  await signIn(page, 'admin');
  await open(page);

  await page.getByLabel('Ticket ID').fill('not-an-id');
  await expect(page.getByText('Enter the ticket ID (a UUID).')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save label' })).toBeDisabled();
  expect(api.labelSaves()).toHaveLength(0);

  await page.getByLabel('Ticket ID').fill('20000000-0000-4000-8000-000000000009');
  await page.getByLabel('Reference category').selectOption({ label: 'Software' });
  await page.getByRole('button', { name: 'Save label' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Ticket not found');
});

test('an error offers a retry that recovers', async ({ page }) => {
  const api = await installMockApi(page);
  await signIn(page, 'admin');
  api.failNext('evaluation', 500);
  await open(page);
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Unable to load the evaluation',
  );
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(kpi(page, 'eval-accuracy')).toContainText('33.33%');
});

test('employees and technicians cannot open the page or read the data', async ({ page }) => {
  const api = await installMockApi(page);
  await signIn(page, 'employee');
  await page.goto('/admin/evaluation?from=2026-03-01&to=2026-03-31');
  await expect(page).toHaveURL(/\/employee$/);
  expect(api.reportRequests()).toHaveLength(0);
  const status = await page.evaluate(async () => {
    const res = await fetch('/api/admin/reports/ai-evaluation?start=2026-03-01&end=2026-04-01');
    return res.status;
  });
  expect(status).toBe(403);

  const second = await page.context().newPage();
  await installMockApi(second);
  await signIn(second, 'technician');
  await second.goto('/admin/evaluation');
  await expect(second).toHaveURL(/\/technician$/);
});

test('fits a phone screen without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await installMockApi(page);
  await signIn(page, 'admin');
  await open(page);
  await expect(kpi(page, 'eval-accuracy')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
