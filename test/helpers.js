import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const INSTANCE = 'dev12345.service-now.com';
export const USER = 'discovery.user';
export const PASSWORD = 'not-a-real-secret';
export const ME = 'a'.repeat(32);

// Minimal fake of the ServiceNow Table API. It records every request so tests
// can assert that only GET was ever used, and projects sysparm_fields.
export async function startMockServiceNow({ tables = {}, forbidden = [], missing = [], expectedAuth } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    requests.push({ method: req.method, path: url.pathname, params: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'mock only allows GET' });
    if (expectedAuth && req.headers.authorization !== expectedAuth) return send(401, { error: 'unauthorized' });
    const match = url.pathname.match(/^\/api\/now\/table\/([a-z0-9_]+)$/);
    if (!match) return send(404, { error: 'not found' });
    const table = match[1];
    if (forbidden.includes(table)) return send(403, { error: 'forbidden' });
    if (missing.includes(table) || !(table in tables)) return send(400, { error: 'invalid table' });
    const rows = typeof tables[table] === 'function' ? tables[table](url.searchParams) : tables[table];
    const fields = url.searchParams.get('sysparm_fields')?.split(',') ?? [];
    const offset = Number(url.searchParams.get('sysparm_offset') ?? 0);
    const limit = Number(url.searchParams.get('sysparm_limit') ?? rows.length);
    const page = rows.slice(offset, offset + limit).map((r) => Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]])));
    send(200, { result: page });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // Redirect https://<instance> to the local mock; the client itself is unchanged.
  const fetchImpl = (url, init) => fetch(String(url).replace(`https://${INSTANCE}`, `http://127.0.0.1:${port}`), init);
  return { requests, fetchImpl, close: () => new Promise((r) => server.close(r)) };
}

export function basicAuth(user = USER, password = PASSWORD) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

// A throwaway YallaFlow-shaped project with one work item.
export function makeProject(workId = 'PF-0001') {
  const root = mkdtempSync(path.join(tmpdir(), 'snowgate-test-'));
  mkdirSync(path.join(root, '.yallaflow', 'work', workId), { recursive: true });
  return root;
}
