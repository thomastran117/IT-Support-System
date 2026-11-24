export function parseHttpOrigin(name: string, value: string): URL {
  const message = `${name} must be an HTTP(S) origin without credentials`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(message);
  }
  return url;
}

export function parseInteger(
  name: string,
  value: string | number,
  min: number,
  max: number,
): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

export function parseExecutionMode(name: string, value: string | undefined) {
  const mode = value || 'local';
  if (mode !== 'local' && mode !== 'service') throw new Error(`${name} must be local or service`);
  return mode;
}
