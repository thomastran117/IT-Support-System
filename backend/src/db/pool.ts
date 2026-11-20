import pg from 'pg';

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 3000 });
}

export type DbCheck = () => Promise<boolean>;

export function poolCheck(pool: pg.Pool): DbCheck {
  return async () => {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  };
}
