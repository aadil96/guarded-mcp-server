import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export type QueryResult<T> = { rows: T[]; affectedRows: number };
export type TestClient = {
  query<T = Record<string, unknown>>(q: string, params?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
};

// With DATABASE_URL set (CI), each test file gets its own throwaway database on real Postgres.
// Without it, tests use in-memory PGlite for a fast local loop.
export async function freshDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    const pglite = new PGlite();
    const db = drizzlePglite(pglite);
    await migratePglite(db, { migrationsFolder: 'drizzle' });
    const client: TestClient = {
      async query<T>(q: string, params?: unknown[]) {
        const r = await pglite.query<T>(q, params);
        return { rows: r.rows, affectedRows: r.affectedRows ?? 0 };
      },
      close: () => pglite.close(),
    };
    return { client, db, url: undefined as string | undefined };
  }

  const name = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const dbUrl = new URL(url);
  dbUrl.pathname = `/${name}`;
  const pgClient = new pg.Client({ connectionString: dbUrl.toString() });
  await pgClient.connect();
  const db = drizzlePg(pgClient);
  await migratePg(db, { migrationsFolder: 'drizzle' });
  const client: TestClient = {
    async query<T>(q: string, params?: unknown[]) {
      const r = await pgClient.query(q, params);
      return { rows: r.rows as T[], affectedRows: r.rowCount ?? 0 };
    },
    close: () => pgClient.end(),
  };
  return { client, db, url: dbUrl.toString() as string | undefined };
}

/** Starts the stdio server with stdin closed and resolves with its exit code and stderr. */
export async function startServer(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
  const [code] = (await once(child, 'exit')) as [number | null];
  return { code, stderr };
}

/** An MCP client wired to createServer over an in-memory transport, with the audit transport hook in place. */
export async function mcpClient(
  db: import('../src/db/types.js').AppDb,
  caller: import('../src/audit/log.js').Caller,
  tools?: readonly import('../src/tools/framework.js').DefinedTool[],
) {
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { AuditTracker, auditingTransport } = await import('../src/audit/transport.js');
  const { createServer } = await import('../src/server.js');
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const tracker = new AuditTracker();
  await createServer(db, caller, tracker, tools).connect(auditingTransport(serverT, db, caller, tracker));
  type Msg = { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } };
  const pending = new Map<number, (m: Msg) => void>();
  clientT.onmessage = (m) => { const msg = m as Msg; if (typeof msg.id === 'number') pending.get(msg.id)?.(msg); };
  await clientT.start();
  let id = 0;
  const send = (method: string, params: unknown) => new Promise<Msg>((res) => {
    const n = ++id;
    pending.set(n, res);
    void clientT.send({ jsonrpc: '2.0', id: n, method, params } as never);
  });
  await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);
  return {
    send,
    async list() { return ((await send('tools/list', {})).result?.tools ?? []) as { name: string; inputSchema: unknown; annotations: Record<string, boolean> }[]; },
    /** isError is true for tool errors and JSON-RPC errors; data is the parsed text content when it is JSON. */
    async call(name: string, args: unknown) {
      const m = await send('tools/call', { name, arguments: args });
      if (m.error) return { isError: true, data: { rpcError: m.error }, raw: m };
      const r = m.result as { isError?: boolean; content?: { type: string; text: string }[] };
      const txt = r.content?.[0]?.text ?? 'null';
      // biome-ignore lint/suspicious/noExplicitAny: parsed tool output, asserted field by field in tests
      let data: any;
      try { data = JSON.parse(txt); } catch { data = { text: txt }; }
      return { isError: r.isError === true, data, raw: m };
    },
    close: () => clientT.close(),
  };
}

/** Same AppDb, but any audit insert inside a transaction fails, to prove the business write rolls back with it. */
export function auditFailing(inner: import('../src/db/types.js').AppDb) {
  type AppDb = import('../src/db/types.js').AppDb;
  type AppTx = import('../src/db/types.js').AppTx;
  const wrapped = Object.create(inner) as AppDb;
  wrapped.transaction = ((fn: (tx: AppTx) => Promise<unknown>) => inner.transaction(async (tx) => {
    const { auditEvents } = await import('../src/db/schema.js');
    const failing = Object.create(tx) as AppTx;
    failing.insert = ((table: unknown) => {
      if (table === auditEvents) throw new Error('forced audit failure');
      return tx.insert(table as typeof auditEvents);
    }) as AppTx['insert'];
    return fn(failing);
  })) as AppDb['transaction'];
  return wrapped;
}
