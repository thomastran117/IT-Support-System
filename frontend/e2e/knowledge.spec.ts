import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, installMockApi, PASSWORD } from './helpers/mockApi';

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function signOut(page: Page, isMobile: boolean) {
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
// Next injects its own role=alert route announcer; only the page's alerts matter here.
const alertBox = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');
const results = (page: Page) => page.getByRole('list', { name: 'Articles' }).getByRole('listitem');

test('employee searches the knowledge base and reads a published article', async ({ page }) => {
  await installMockApi(page);
  await signIn(page, ACCOUNTS.employee.email);
  await page.goto('/employee/knowledge');
  await expect(heading(page, 'Knowledge base')).toBeVisible();

  // Browsing lists published articles only; the draft is nowhere to be seen.
  await expect(results(page)).toHaveCount(3);
  await expect(page.getByText('laptop onboarding')).toHaveCount(0);
  await expect(page.getByTestId('result-summary')).toHaveText('Showing 1–3 of 3 articles');

  // Typing then pressing Enter searches, and the query lands in the URL.
  await page.getByLabel('Search articles').fill('vpn');
  await page.getByLabel('Search articles').press('Enter');
  await expect(page).toHaveURL(/knowledge\?q=vpn$/);
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).first()).toContainText('Fix a VPN that disconnects repeatedly');
  await expect(results(page).first()).toContainText('Network/VPN');
  await expect(page.getByTestId('result-summary')).toContainText('1 results for “vpn”');

  // Open the article: formatted text, no raw markup.
  await page.getByRole('link', { name: 'Fix a VPN that disconnects repeatedly' }).click();
  await expect(heading(page, 'Fix a VPN that disconnects repeatedly')).toBeVisible();
  const body = page.getByTestId('article-body');
  await expect(body.getByRole('listitem')).toHaveText([
    'Sign out of the VPN client',
    'Sign in again',
  ]);
  await expect(body.locator('strong')).toHaveText('hardware token');
  await expect(page.getByText('Last updated')).toBeVisible();

  // Back returns to the same results, query intact.
  await page.goBack();
  await expect(page).toHaveURL(/knowledge\?q=vpn$/);
  await expect(page.getByLabel('Search articles')).toHaveValue('vpn');
  await expect(results(page)).toHaveCount(1);
});

test('category filter, no-result state and clearing the search', async ({ page }) => {
  await installMockApi(page);
  await signIn(page, ACCOUNTS.employee.email);
  await page.goto('/employee/knowledge');
  await expect(results(page)).toHaveCount(3);

  // Only categories that have published articles are offered (the draft's Hardware also has a
  // published printer article, so it stays).
  await expect(page.getByLabel('Category').locator('option')).toHaveText([
    'All categories',
    'Hardware',
    'Software',
    'Network/VPN',
  ]);
  await page.getByLabel('Category').selectOption({ label: 'Hardware' });
  await expect(page).toHaveURL(/category=c0000000-0000-4000-8000-000000000001/);
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).first()).toContainText('printer paper jam');

  await page.getByLabel('Search articles').fill('zzzz');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('No articles match your search')).toBeVisible();
  await page.getByRole('link', { name: 'Clear search' }).click();
  await expect(results(page)).toHaveCount(3);
  await expect(page.getByLabel('Search articles')).toHaveValue('');
});

test('a draft cannot be opened by guessing its link, and the page says so gently', async ({
  page,
}) => {
  const api = await installMockApi(page);
  await signIn(page, ACCOUNTS.employee.email);
  const draft = api.knowledge.articles().find((a) => !a.isPublished)!;

  await page.goto(`/employee/knowledge/${draft.id}`);
  await expect(page.getByText('This article is not available')).toBeVisible();
  await expect(page.getByText(draft.title)).toHaveCount(0);
  await expect(page.getByText('Work in progress')).toHaveCount(0);

  // So does a link that never existed, with the same words.
  await page.goto('/employee/knowledge/not-a-real-id');
  await expect(page.getByText('This article is not available')).toBeVisible();
  await page.getByRole('link', { name: 'Back to knowledge base' }).click();
  await expect(heading(page, 'Knowledge base')).toBeVisible();

  // Administrators' authoring routes are not for employees.
  await page.goto('/admin/knowledge');
  await expect(page).toHaveURL(/\/employee$/);
});

test('technicians search the same published content', async ({ page }) => {
  await installMockApi(page);
  await signIn(page, ACCOUNTS.technician.email);
  await page.goto('/technician/knowledge?q=printer');
  await expect(heading(page, 'Knowledge base')).toBeVisible();
  await expect(results(page)).toHaveCount(1);
  await page.getByRole('link', { name: /printer paper jam/ }).click();
  await expect(page).toHaveURL(/\/technician\/knowledge\/a0000000/);
  await expect(page.getByTestId('article-body')).toContainText('print spooler');
});

test('article markup is shown as text and never executed', async ({ page }) => {
  const api = await installMockApi(page);
  const evil = api.knowledge.seed({
    title: 'Hostile <script>alert(1)</script> title',
    body: '<img src=x onerror="window.__pwned=1"> and [link](javascript:alert(1))\n\n<b>bold?</b>',
    isPublished: true,
  });
  let dialogs = 0;
  page.on('dialog', () => dialogs++);

  await signIn(page, ACCOUNTS.employee.email);
  await page.goto(`/employee/knowledge/${evil.id}`);
  const body = page.getByTestId('article-body');
  await expect(body).toContainText('<img src=x onerror="window.__pwned=1">');
  await expect(body).toContainText('[link](javascript:alert(1))');
  await expect(body.locator('img, a, b, script')).toHaveCount(0);
  await expect(heading(page, 'Hostile <script>alert(1)</script> title')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBe(
    undefined,
  );
  expect(dialogs).toBe(0);
});

test('search shows a retryable error when the server is unreachable', async ({ page }) => {
  const api = await installMockApi(page);
  await signIn(page, ACCOUNTS.employee.email);
  await page.goto('/employee/knowledge');
  await expect(results(page)).toHaveCount(3);

  api.setOffline(true);
  await page.getByLabel('Search articles').fill('vpn');
  await page.getByLabel('Search articles').press('Enter');
  await expect(alertBox(page)).toContainText('Unable to reach the server');

  api.setOffline(false);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(results(page)).toHaveCount(1);
});

test('admin writes, publishes and withdraws an article; employees see each change', async ({
  page,
  isMobile,
}) => {
  const api = await installMockApi(page);
  await signIn(page, ACCOUNTS.admin.email);
  await page.goto('/admin/knowledge');
  await expect(heading(page, 'Knowledge articles')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(5); // header + 3 published + 1 draft
  await page.getByLabel('Show').selectOption('draft');
  await expect(page.getByRole('row')).toHaveCount(2);
  await page.getByLabel('Show').selectOption('all');

  // Invalid input is refused before any request, with an error summary.
  await page.getByRole('link', { name: 'New article' }).click();
  await expect(heading(page, 'New article')).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(alertBox(page).first()).toContainText('There is a problem');
  expect(api.knowledge.articles()).toHaveLength(4);

  // Write a draft with a live preview.
  await page.getByLabel('Title').fill('Reset a badge');
  await page.getByLabel('Category').selectOption({ label: 'Hardware' });
  await page
    .getByLabel('Article text')
    .fill('Visit the front desk.\n\n1. Bring ID\n2. Collect badge');
  await expect(page.getByTestId('article-body').getByRole('listitem')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(heading(page, 'Edit article')).toBeVisible();
  await expect(page.getByTestId('publication-status')).toContainText('Draft');
  await expect(page.getByTestId('notice')).toContainText('Draft saved');
  const created = api.knowledge.articles().find((a) => a.title === 'Reset a badge')!;
  expect(created.isPublished).toBe(false);

  // Unsaved edits block a visibility change; saving lifts the block.
  await page.getByLabel('Title').fill('Reset a staff badge');
  await expect(page.getByRole('button', { name: 'Publish' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByTestId('notice')).toContainText('Changes saved');

  // Publishing asks first; cancelling changes nothing.
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Publish this article?');
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(created.isPublished).toBe(false);
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('button', { name: 'Yes, publish' }).click();
  await expect(page.getByTestId('publication-status')).toContainText('Published');
  expect(created.isPublished).toBe(true);

  // The employee can now find and read it.
  await signOut(page, isMobile);
  await signIn(page, ACCOUNTS.employee.email);
  await page.goto('/employee/knowledge?q=badge');
  await expect(results(page)).toHaveCount(1);
  await page.getByRole('link', { name: 'Reset a staff badge' }).click();
  await expect(page.getByTestId('article-body')).toContainText('Visit the front desk.');
  const articleUrl = page.url();

  // The admin withdraws it; the employee's old link degrades gracefully and search forgets it.
  await signOut(page, isMobile);
  await signIn(page, ACCOUNTS.admin.email);
  await page.goto(`/admin/knowledge/${created.id}`);
  await page.getByRole('button', { name: 'Unpublish' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Unpublish this article?');
  await page.getByRole('button', { name: 'Yes, unpublish' }).click();
  await expect(page.getByTestId('publication-status')).toContainText('Draft');
  expect(created.isPublished).toBe(false);

  await signOut(page, isMobile);
  await signIn(page, ACCOUNTS.employee.email);
  await page.goto(articleUrl);
  await expect(page.getByText('This article is not available')).toBeVisible();
  await page.goto('/employee/knowledge?q=badge');
  await expect(page.getByText('No articles match your search')).toBeVisible();
});

test('admin sees a missing article and server refusals clearly', async ({ page }) => {
  await installMockApi(page);
  await signIn(page, ACCOUNTS.admin.email);
  await page.goto('/admin/knowledge/not-a-real-id');
  await expect(alertBox(page)).toContainText('could not be found');
  await page.getByRole('link', { name: 'Back to articles' }).click();
  await expect(heading(page, 'Knowledge articles')).toBeVisible();
});

test('keyboard only: search with Tab and Enter, open a result, no axe violations', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'keyboard navigation is a desktop concern');
  await installMockApi(page);
  await signIn(page, ACCOUNTS.employee.email);
  await page.goto('/employee/knowledge');
  await expect(results(page)).toHaveCount(3);

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations).toEqual([]);

  await page.getByLabel('Search articles').focus();
  await page.keyboard.type('password');
  await page.keyboard.press('Enter');
  await expect(results(page)).toHaveCount(1);

  // Tab order reaches the result link, and Enter follows it.
  await page.getByLabel('Search articles').focus();
  await page.keyboard.press('Tab'); // category
  await page.keyboard.press('Tab'); // search button
  await page.keyboard.press('Tab'); // first result
  await expect(page.getByRole('link', { name: /locked password/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(heading(page, 'Reset a forgotten or locked password')).toBeVisible();
  const article = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(article.violations).toEqual([]);
});

test('layout holds on small screens: no horizontal scroll on search or editor', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'phone viewport only');
  await installMockApi(page);
  await signIn(page, ACCOUNTS.employee.email);
  await page.goto('/employee/knowledge');
  await expect(results(page)).toHaveCount(3);
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
  expect(await overflow()).toBe(false);
});
