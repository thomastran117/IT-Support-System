import { lookup as systemLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

const resolver = new Resolver({ timeout: 1000, tries: 1 });

/**
 * A `lookup` for outbound connections to dependencies that may disappear.
 *
 * Node's default `dns.lookup` calls getaddrinfo on the libuv threadpool (four threads). On an
 * internal Docker network, the name of a stopped container takes about five seconds to fail, so
 * a few lookups for one missing dependency occupy the whole pool and stall every other lookup in
 * the process, including those for healthy services (SD-058 risk R6). This resolver queries DNS
 * through c-ares off the threadpool, fails a missing name at once, and bounds a slow server to
 * one second. Literal addresses and `localhost` still use the system resolver and hosts file.
 */
export function nonBlockingLookup(
  hostname: string,
  options: LookupOptions | number | LookupCallback,
  callback?: LookupCallback,
): void {
  const done = (typeof options === 'function' ? options : callback) as LookupCallback;
  const opts: LookupOptions =
    typeof options === 'object' ? options : typeof options === 'number' ? { family: options } : {};
  if (isIP(hostname) || hostname === 'localhost') {
    systemLookup(hostname, { ...opts, all: !!opts.all }, (error, address, family) =>
      done(error, address as string | LookupAddress[], family),
    );
    return;
  }
  const family = opts.family === 'IPv6' ? 6 : opts.family === 'IPv4' ? 4 : opts.family;
  const query = (version: 4 | 6) =>
    (version === 4 ? resolver.resolve4(hostname) : resolver.resolve6(hostname)).then((list) =>
      list.map((address) => ({ address, family: version })),
    );
  const attempt =
    family === 6 ? query(6) : family === 4 ? query(4) : query(4).catch(() => query(6));
  attempt.then(
    (addresses) => {
      if (!addresses.length) {
        done(Object.assign(new Error(`queryA ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '');
      } else if (opts.all) done(null, addresses);
      else done(null, addresses[0]!.address, addresses[0]!.family);
    },
    (error: NodeJS.ErrnoException) => done(error, ''),
  );
}
