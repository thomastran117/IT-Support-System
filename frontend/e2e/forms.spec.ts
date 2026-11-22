import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, installMockApi, PASSWORD } from './helpers/mockApi';

async function signIn(page: Page, account: keyof typeof ACCOUNTS) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ACCOUNTS[account].email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${ACCOUNTS[account].portal}$`));
}

// Next injects its own role=alert route announcer; only the page's alerts matter here.
const alertBox = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

test.describe('shared form behaviour', () => {
  test('knowledge editor: errors move focus, link to the field and are described', async ({
    page,
  }) => {
    await installMockApi(page);
    await signIn(page, 'admin');
    await page.goto('/admin/knowledge/new');
    await page.getByRole('button', { name: 'Save draft' }).click();

    // Focus lands on the summary, so a keyboard or screen-reader user hears the problem.
    const summary = alertBox(page).first();
    await expect(summary).toBeFocused();
    await expect(summary).toContainText('There is a problem');

    // Each message is a link that focuses its field.
    await summary.getByRole('link', { name: /title/i }).click();
    const title = page.getByLabel('Title');
    await expect(title).toBeFocused();
    await expect(title).toHaveAttribute('aria-invalid', 'true');
    const described = await title.getAttribute('aria-describedby');
    expect(described).toContain('title-count');
  });

  test('knowledge editor: a network failure keeps the text and a retry saves it', async ({
    page,
  }) => {
    const api = await installMockApi(page);
    await signIn(page, 'admin');
    await page.goto('/admin/knowledge/new');
    await page.getByLabel('Title').fill('Reset a badge');
    await page.getByLabel('Article text').fill('Visit the front desk.');

    api.setOffline(true);
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(alertBox(page).first()).toContainText('Unable to reach the server');
    await expect(alertBox(page).first()).toContainText('still here');
    await expect(page.getByLabel('Title')).toHaveValue('Reset a badge');
    await expect(page.getByLabel('Article text')).toHaveValue('Visit the front desk.');
    const before = api.knowledge.articles().length;

    api.setOffline(false);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Edit article' })).toBeVisible();
    expect(api.knowledge.articles()).toHaveLength(before + 1);
  });

  test('admin catalog: the name error is linked to the field and clears on a valid save', async ({
    page,
  }) => {
    await installMockApi(page);
    await signIn(page, 'admin');
    await page.goto('/admin/categories');
    await expect(page.getByRole('heading', { level: 1, name: 'Categories' })).toBeVisible();

    const name = page.locator('#new-category-name');
    await page.getByRole('button', { name: 'Add category' }).click();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    const errorId = await name.getAttribute('aria-describedby');
    expect(errorId).toBeTruthy();
    await expect(page.locator(`#${errorId}`)).toHaveText('Enter a name.');

    await name.fill('Printers');
    await page.getByRole('button', { name: 'Add category' }).click();
    await expect(page.getByRole('listitem', { name: 'Printers', exact: true })).toBeVisible();
  });
});
