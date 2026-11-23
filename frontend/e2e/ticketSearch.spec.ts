import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from './helpers/mockApi';

const scenario = process.env.E2E_TICKET_SEARCH;
const vpnId = '00000004-0000-4000-8000-000000000002';
const monitorId = '00000004-0000-4000-8000-000000000005';
const searchInput = (page: Page) => page.getByRole('searchbox', { name: 'Search tickets' });
const filters = (page: Page) => page.getByRole('group', { name: 'Search filters' });
const results = (page: Page) => page.getByRole('list', { name: 'Ticket search results' });

async function signIn(page: Page, user: 'erin' | 'tara' | 'admin') {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`${user}@smartdesk.test`);
  await page.getByLabel('Password').fill('SmartDesk-Demo-1!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const route = { erin: '/employee', tara: '/technician', admin: '/admin' }[user];
  await expect(page).toHaveURL(new RegExp(`${route}$`));
}

test('debounces typing and keeps newer results when an older search is pending', async ({
  page,
  isMobile,
}) => {
  test.skip(!!scenario || isMobile, 'Runs with the ordinary desktop browser suite');
  await installMockApi(page);
  const seen: string[] = [];
  let releaseFirst!: () => void;
  const firstResponse = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const createdAt = '2026-03-15T12:00:00.000Z';
  await page.route('**/api/tickets/search?*', async (route) => {
    const headers = {
      'access-control-allow-origin': route.request().headers().origin ?? 'http://127.0.0.1:3100',
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'authorization',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const q = new URL(route.request().url()).searchParams.get('q')!;
    seen.push(q);
    if (q === 'first') await firstResponse;
    await route
      .fulfill({
        headers,
        json: {
          data: {
            mode: 'text',
            consistency: 'eventual',
            nextCursor: null,
            items: [
              {
                id: vpnId,
                trackingId: vpnId,
                title: `${q} result`,
                status: 'OPEN',
                priority: 'UNSET',
                category: null,
                team: null,
                assignee: null,
                createdAt,
                updatedAt: createdAt,
                resolvedAt: null,
                firstResponseAt: null,
                version: 1,
              },
            ],
          },
        },
      })
      .catch((error: unknown) => {
        if (q !== 'first') throw error;
      });
  });
  try {
    await signIn(page, 'erin');
    await searchInput(page).fill('fir');
    await searchInput(page).fill('first');
    await expect.poll(() => seen).toEqual(['first']);
    await searchInput(page).fill('fresh');
    await expect(results(page)).toContainText('fresh result');
    expect(seen).toEqual(['first', 'fresh']);
    releaseFirst();
    await expect(results(page)).not.toContainText('first result');
  } finally {
    releaseFirst();
  }
});

test.describe('ticket search with the real API', () => {
  test.skip(scenario !== 'enabled', 'Requires the seeded search API');

  test('employee searches their own tickets, filters and pages through URL state', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'Desktop coverage for filtering and pagination');
    await signIn(page, 'erin');
    await searchInput(page).fill('browserdiags');
    await expect(page).toHaveURL(/q=browserdiags/);
    await expect(results(page).getByRole('listitem')).toHaveCount(10);
    await expect(results(page)).not.toContainText('Private browser diagnostic');
    await expect(results(page)).not.toContainText('details only visible');
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await expect(filters(page).getByLabel('Team', { exact: true })).toHaveCount(0);
    await expect(filters(page).getByLabel('Assignee', { exact: true })).toHaveCount(0);
    await filters(page).getByLabel('Status', { exact: true }).selectOption('OPEN');
    await filters(page).getByLabel('Priority', { exact: true }).selectOption('UNSET');
    await filters(page).getByLabel('Created from (UTC)').fill('2026-03-15');
    await filters(page).getByLabel('Created through (UTC)').fill('2026-03-15');
    await expect(page).toHaveURL(/createdTo=2026-03-15/);
    await expect(results(page).getByRole('listitem')).toHaveCount(10);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/cursor=/);
    await expect(results(page).getByRole('listitem')).toHaveCount(2);
    await page.reload();
    await expect(searchInput(page)).toHaveValue('browserdiags');
    await expect(results(page).getByRole('listitem')).toHaveCount(2);
    await page.getByRole('button', { name: 'First page' }).click();
    await expect(results(page).getByRole('listitem')).toHaveCount(10);
    await page.getByRole('button', { name: 'Reset filters' }).click();
    await expect(searchInput(page)).toHaveValue('browserdiags');
    await expect(page).not.toHaveURL(/status=|priority=|createdFrom=|createdTo=/);
    await searchInput(page).fill(monitorId);
    await expect(page.getByText('No tickets match this search')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByRole('table', { name: 'Your tickets, newest first' })).toBeVisible();
  });

  test('technician can find team and unrouted tickets and return from triage', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'Desktop coverage for technician scope');
    await signIn(page, 'tara');
    await searchInput(page).fill('vnp');
    await expect(
      results(page).getByRole('link', { name: 'VPN disconnects every hour' }),
    ).toBeVisible();
    await expect(
      results(page).getByRole('link', { name: 'Hardware token shows expired' }),
    ).toBeVisible();
    await expect(results(page)).toContainText('Unrouted');
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    const team = filters(page).getByLabel('Team', { exact: true });
    await expect(team.getByRole('option', { name: 'Network & Access' })).toHaveCount(1);
    await expect(team.getByRole('option', { name: 'Hardware & Devices' })).toHaveCount(0);
    await team.selectOption({ label: 'Network & Access' });
    await expect(results(page)).not.toContainText('Hardware token shows expired');
    await results(page).getByRole('link', { name: 'VPN disconnects every hour' }).click();
    await expect(page).toHaveURL(new RegExp(`/technician/tickets/${vpnId}\\?q=vnp&teamId=`));
    await page.getByRole('link', { name: 'Back to search results' }).click();
    await expect(team).not.toHaveValue('');
    await expect(results(page)).toContainText('VPN disconnects every hour');
    await page.getByRole('button', { name: 'Reset filters' }).click();
    await searchInput(page).fill(monitorId);
    await expect(page.getByText('No tickets match this search')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByRole('tab', { name: 'Unassigned' })).toBeVisible();
  });

  test('admin searches across teams and can open authorized details', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'Desktop coverage for admin scope');
    await signIn(page, 'admin');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Tickets', exact: true })
      .click();
    await searchInput(page).fill('monitor');
    await expect(
      results(page).getByRole('link', { name: 'External monitor flickers' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    const team = filters(page).getByLabel('Team', { exact: true });
    await expect(team.getByRole('option', { name: 'Hardware & Devices' })).toHaveCount(1);
    await team.selectOption({ label: 'Hardware & Devices' });
    const assignee = filters(page).getByLabel('Assignee', { exact: true });
    await expect(assignee.getByRole('option', { name: 'Hana Technician' })).toHaveCount(1);
    await assignee.selectOption({ label: 'Hana Technician' });
    await expect(page).toHaveURL(/assigneeId=/);
    await results(page).getByRole('link', { name: 'External monitor flickers' }).click();
    await expect(
      page.getByRole('heading', { name: 'External monitor flickers', level: 1 }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Back to search results' }).click();
    await expect(results(page)).toContainText('External monitor flickers');
  });

  test('mobile can submit an exact tracking ID with the keyboard', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile keyboard coverage');
    await signIn(page, 'erin');
    const search = searchInput(page);
    await search.fill(vpnId);
    await search.press('Enter');
    await expect(results(page).getByRole('listitem')).toHaveCount(1);
    await expect(results(page)).toContainText(vpnId);
    await expect(
      results(page).getByRole('link', { name: 'VPN disconnects every hour' }),
    ).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test('real OpenSearch outage offers the regular list and an exact lookup', async ({
  page,
  isMobile,
}) => {
  test.skip(scenario !== 'unavailable' || isMobile, 'Requires the API with OpenSearch stopped');
  await signIn(page, 'erin');
  await searchInput(page).fill('vpn');
  await expect(page.getByRole('region', { name: 'My tickets' }).getByRole('alert')).toContainText(
    'Text search is temporarily unavailable',
  );
  await page.getByRole('button', { name: 'Browse my tickets' }).click();
  await expect(page.getByRole('table', { name: 'Your tickets, newest first' })).toBeVisible();
  await expect(page).toHaveURL(/\/employee$/);
  await searchInput(page).fill(vpnId);
  await expect(
    results(page).getByRole('link', { name: 'VPN disconnects every hour' }),
  ).toBeVisible();
});
