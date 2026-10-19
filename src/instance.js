import { SnowgateError } from './errors.js';

export const DEFAULT_INSTANCE_PATTERN = /^[a-z0-9-]+\.service-now\.com$/;

// Normalises user input ("https://Dev123.service-now.com/") to a bare host and
// rejects anything that is not a plain instance host: paths, ports, userinfo.
export function normalizeInstance(input, pattern = DEFAULT_INSTANCE_PATTERN) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new SnowgateError('An instance host is required, e.g. dev12345.service-now.com.', 'INSTANCE_INVALID');
  }
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (/[/@:?#\s]/.test(host) || !pattern.test(host)) {
    throw new SnowgateError(
      `"${input}" is not an allowed instance host (pattern ${pattern}).`,
      'INSTANCE_INVALID',
    );
  }
  return host;
}
