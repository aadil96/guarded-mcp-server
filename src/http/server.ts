import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  localhostAllowedHostnames, localhostAllowedOrigins, validateHostHeader, validateOriginHeader, WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import { AuditTracker, auditingTransport } from '../audit/transport.js';
import { authenticate, type TokenEntry } from '../auth/tokens.js';
import type { AppDb } from '../db/types.js';
import { createServer } from '../server.js';
import { type Rejection, RejectionAuditor, type RejectionLimits } from './rejections.js';

export const MCP_PATH = '/mcp';
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export type HttpOptions = {
  db: AppDb;
  tokens: readonly TokenEntry[];
  host?: string;
  port?: number;
  /** Extra Host names allowed besides localhost, 127.0.0.1 and [::1] (hostnames only, no port). */
  allowedHosts?: readonly string[];
  /** Extra browser Origin hostnames allowed besides the localhost ones. Requests with no Origin pass. */
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
  rejectionLimits?: RejectionLimits;
  /** For tests: the clock the per-IP rejection limit uses. */
  now?: () => number;
};

class TooLarge extends Error {}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new TooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function sendResponse(res: ServerResponse, r: Response) {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}

/**
 * Streamable HTTP entry. Every request is checked in this order, each failure answered before anything is
 * parsed: path, declared body size (413), Host and Origin (DNS rebinding, 403), bearer token (401), then the
 * body is read with the same cap. The caller (actor, role, scopes) comes from the token only. Each request is
 * served statelessly by a fresh server from createServer, the same factory stdio uses, so tools/list matches.
 */
export function startHttpServer(opts: HttpOptions) {
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const hosts = [...localhostAllowedHostnames(), ...(opts.allowedHosts ?? [])];
  const origins = [...localhostAllowedOrigins(), ...(opts.allowedOrigins ?? [])];
  const rejections = new RejectionAuditor(opts.db, opts.rejectionLimits, opts.now);
  rejections.startPeriodicFlush();

  const reject = async (res: ServerResponse, r: Rejection, body: unknown, headers?: Record<string, string>) => {
    try {
      await rejections.record(r);
    } catch (e) {
      console.error('rejection audit failed:', (e as Error).message);
    }
    sendJson(res, r.status, body, headers);
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== MCP_PATH) return sendJson(res, 404, { error: 'not_found' });
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBody) {
      res.setHeader('connection', 'close');
      return reject(res, { ip, method, status: 413, errorCode: 'body_too_large' }, { error: 'body_too_large', maxBytes: maxBody });
    }
    if (!validateHostHeader(req.headers.host, hosts).ok) {
      return reject(res, { ip, method, status: 403, errorCode: 'invalid_host' }, { error: 'invalid_host' });
    }
    if (!validateOriginHeader(req.headers.origin, origins).ok) {
      return reject(res, { ip, method, status: 403, errorCode: 'forbidden_origin' }, { error: 'forbidden_origin' });
    }
    const auth = authenticate(req.headers.authorization, opts.tokens);
    if (!auth.ok) {
      const challenge = auth.reason === 'missing_token'
        ? 'Bearer realm="guarded-mcp-server"'
        : 'Bearer realm="guarded-mcp-server", error="invalid_token", error_description="The access token is invalid"';
      return reject(res, { ip, method, status: 401, errorCode: auth.reason }, { error: auth.reason }, { 'www-authenticate': challenge });
    }
    const { caller } = auth;
    // Stateless: no session to resume, so no GET stream and no DELETE.
    if (method !== 'POST') {
      return reject(res, { ip, method, status: 405, errorCode: 'method_not_allowed', caller }, { error: 'method_not_allowed' }, { allow: 'POST' });
    }
    let body: Buffer;
    try {
      body = await readBody(req, maxBody);
    } catch (e) {
      if (!(e instanceof TooLarge)) throw e;
      res.setHeader('connection', 'close');
      return reject(res, { ip, method, status: 413, errorCode: 'body_too_large', caller }, { error: 'body_too_large', maxBytes: maxBody });
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'authorization' || k === 'host' || v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const request = new Request(new URL(MCP_PATH, `http://${req.headers.host}`), { method, headers, body: new Uint8Array(body) });
    const tracker = new AuditTracker();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: maxBody });
    const server = createServer(opts.db, caller, tracker);
    try {
      await server.connect(auditingTransport(transport, opts.db, caller, tracker));
      await sendResponse(res, await transport.handleRequest(request));
    } finally {
      await server.close().catch(() => {});
    }
  }

  const http = createHttpServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('http request failed:', e instanceof Error ? e.message : 'unknown error');
      sendJson(res, 500, { error: 'internal_error' });
    });
  });
  http.requestTimeout = 30_000;
  http.headersTimeout = 10_000;

  return new Promise<{ url: URL; close: () => Promise<void>; rejections: RejectionAuditor }>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const a = http.address() as AddressInfo;
      const host = a.family === 'IPv6' ? `[${a.address}]` : a.address;
      resolve({
        url: new URL(`http://${host}:${a.port}${MCP_PATH}`),
        rejections,
        close: async () => {
          await new Promise<void>((r) => { http.close(() => r()); http.closeAllConnections(); });
          await rejections.close();
        },
      });
    });
  });
}
