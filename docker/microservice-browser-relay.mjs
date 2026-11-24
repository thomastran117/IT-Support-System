import { connect, createServer } from 'node:net';

// The browser uses a loopback origin for Web Crypto. Relay its API socket to the real gateway.
createServer((browser) => {
  const gateway = connect(4000, 'gateway');
  browser.on('error', () => gateway.destroy());
  gateway.on('error', () => browser.destroy());
  browser.pipe(gateway).pipe(browser);
}).listen(4000, '127.0.0.1');
