export const publicRoutes = {
  ticket: {
    exact: ['/health/live', '/health/ready', '/api/ping', '/api/echo'],
    prefixes: [
      '/api/tickets',
      '/api/admin/tickets',
      '/api/admin/classification-labels',
      '/api/teams',
      '/api/admin/teams',
      '/api/categories',
      '/api/admin/categories',
      '/api/technician',
    ],
  },
  identity: { exact: [], prefixes: ['/api/auth', '/api/admin/users', '/api/admin/audit-log'] },
  knowledge: { exact: [], prefixes: ['/api/knowledge', '/api/admin/knowledge'] },
  analytics: { exact: [], prefixes: ['/api/admin/reports'] },
  notifications: { exact: [], prefixes: ['/api/notifications'] },
} as const;

type Owner = keyof typeof publicRoutes;
type Route = { path: string; subtree: boolean; owner: Owner };

/** One owner per public route, including future overlaps between path groups. */
export function resolvePublicRoutes(
  origins: Record<Owner, URL | undefined>,
  legacy?: URL,
): { path: string; origin: URL }[] {
  const registry: Route[] = [];
  const routes: { path: string; origin: URL }[] = [];
  for (const owner of Object.keys(publicRoutes) as Owner[]) {
    const origin = origins[owner] ?? legacy;
    if (!origin) throw new Error(`Missing gateway origin for ${owner}`);
    const group = publicRoutes[owner];
    for (const route of [
      ...group.exact.map((path) => ({ path, subtree: false, owner })),
      ...group.prefixes.map((path) => ({ path, subtree: true, owner })),
    ]) {
      const overlap = registry.find(
        (current) =>
          current.path === route.path ||
          (current.subtree && route.path.startsWith(`${current.path}/`)) ||
          (route.subtree && current.path.startsWith(`${route.path}/`)),
      );
      if (overlap) throw new Error(`Overlapping gateway paths for ${overlap.owner} and ${owner}`);
      registry.push(route);
      routes.push({ path: route.path, origin });
      if (route.subtree) routes.push({ path: `${route.path}/*`, origin });
    }
  }
  return routes;
}
