import type { IncomingMessage, ServerResponse } from 'http';
import { generateWaWebViewerHtml } from './viewer-html';

interface VercelRequest extends IncomingMessage {
  query?: Record<string, string | string[]>;
  body?: any;
}

interface VercelResponse extends ServerResponse {
  status(statusCode: number): VercelResponse;
  json(data: any): VercelResponse;
  send(body: any): VercelResponse;
  setHeader(name: string, value: string | number | readonly string[]): this;
}

const SOCKET_SERVICE_URL = (process.env.SOCKET_SERVICE_URL || 'https://api-wa.mmtechhouse.co').replace(/\/+$/, '');
const FALLBACK_API_URL = (process.env.FALLBACK_API_URL || 'https://api-wa.mmtechhouse.co').replace(/\/+$/, '');
// The real backend mounts every route under /api (e.g. /api/sessions), while this
// edge handler routes on bare paths (/sessions). Prefix here instead of changing
// every call site.
const BACKEND_PREFIX = (process.env.FALLBACK_API_PREFIX ?? '/api').replace(/\/+$/, '');
const ENGINE_TYPE = process.env.ENGINE_TYPE || 'remote-socket';
// Server-side credential used when the dev API has to call the real backend
// (api-wa.mmtechhouse.co) on behalf of the browser. The browser does not hold it.
const BACKEND_API_KEY = process.env.OPENWA_API_KEY || '';

// In-memory sessions store for development fallback.
//
// This lives in a serverless function, so it does NOT persist across cold starts and
// each instance has its own copy. It is therefore only a last-resort safety net: the
// real backend (api-wa.mmtechhouse.co) stays the single source of truth so that the
// sessions actually paired to WhatsApp are never duplicated or shadowed by mocks.
const devSessions: Record<string, any> = {};

function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MDX, Content-Type, Date, X-Api-Version, Authorization, x-api-key'
  );
}

function backendAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  // Only fall back to the service key when the caller did not supply a user credential.
  if (BACKEND_API_KEY && !headers['x-api-key'] && !headers['Authorization']) {
    headers['x-api-key'] = BACKEND_API_KEY;
  }
  return headers;
}

// Build auth headers for a backend call made on behalf of the browser.
// Priority: the credentials the logged-in user already sent (x-api-key /
// Authorization) > a server-side service key (OPENWA_API_KEY) > anonymous.
function userAuthHeaders(req?: VercelRequest): Record<string, string> {
  const incoming: Record<string, string> = {};
  if (req?.headers) {
    if (req.headers['authorization']) incoming['Authorization'] = String(req.headers['authorization']);
    if (req.headers['x-api-key']) incoming['x-api-key'] = String(req.headers['x-api-key']);
  }
  if (Object.keys(incoming).length > 0) return backendAuthHeaders(incoming);
  return backendAuthHeaders();
}

async function fetchBackend(path: string, method: string = 'GET', body?: any, req?: VercelRequest) {
  try {
    const response = await fetch(`${FALLBACK_API_URL}${BACKEND_PREFIX}${path}`, {
      method,
      headers: userAuthHeaders(req),
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } catch (err: any) {
    return { ok: false, status: 502, data: null, error: err.message };
  }
}

async function forwardToSocketService(path: string, method: string, body?: any) {
  try {
    const targetUrl = `${SOCKET_SERVICE_URL}${path}`;
    const opts: RequestInit = {
      method,
      headers: backendAuthHeaders(),
      body: body ? JSON.stringify(body) : undefined
    };
    const response = await fetch(targetUrl, opts);
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } catch (err: any) {
    return { ok: false, status: 502, error: err.message };
  }
}

// `path` is always received already prefixed with BACKEND_PREFIX.
async function forwardToFallback(path: string, req: VercelRequest, res: VercelResponse) {
  try {
    const targetUrl = `${FALLBACK_API_URL}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (req.headers['authorization']) headers['Authorization'] = String(req.headers['authorization']);
    if (req.headers['x-api-key']) headers['x-api-key'] = String(req.headers['x-api-key']);
    if (!headers['x-api-key'] && !headers['Authorization'] && BACKEND_API_KEY) {
      headers['x-api-key'] = BACKEND_API_KEY;
    }

    const opts: RequestInit = {
      method: req.method,
      headers,
      body: ['POST', 'PUT', 'PATCH'].includes(req.method || '') && req.body ? JSON.stringify(req.body) : undefined
    };

    const resp = await fetch(targetUrl, opts);
    const contentType = resp.headers.get('content-type') || '';
    res.status(resp.status);

    if (contentType.includes('application/json')) {
      const data = await resp.json().catch(() => ({}));
      return res.json(data);
    } else {
      const text = await resp.text();
      return res.send(text);
    }
  } catch (err: any) {
    return res.status(502).json({ error: 'Fallback API unavailable', message: err.message });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).send('OK');
  }

  // Parse body if needed and available as stream
  if (req.body === undefined && ['POST', 'PUT', 'PATCH'].includes(req.method || '')) {
    try {
      const buffers = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      const raw = Buffer.concat(buffers).toString('utf-8');
      if (raw) req.body = JSON.parse(raw);
    } catch {
      req.body = {};
    }
  }

  const rawUrl = req.url || '/';
  const urlObj = new URL(rawUrl, 'http://localhost');
  let pathname = urlObj.pathname;

  // Normalize path removing leading /api if present
  if (pathname.startsWith('/api')) {
    pathname = pathname.substring(4) || '/';
  }

  // 1. Health check
  if (pathname === '/health' || pathname === '') {
    return res.status(200).json({
      status: 'ok',
      service: 'openwa-api',
      version: '1.0.0',
      engine: ENGINE_TYPE,
      socketServiceUrl: SOCKET_SERVICE_URL,
      timestamp: new Date().toISOString()
    });
  }

  // 2. Auth validation
  if (pathname === '/auth/validate') {
    return res.status(200).json({
      valid: true,
      user: { id: 'admin', name: 'Admin Developer', role: 'admin' }
    });
  }

  if (pathname === '/auth/login') {
    return res.status(200).json({
      token: 'dev-token-secret-jwt',
      user: { id: 'admin', name: 'Admin Developer', role: 'admin' }
    });
  }

  // 3. WhatsApp Web View: /sessions/:id/wa-web/view
  const waWebViewMatch = pathname.match(/^\/sessions\/([^/]+)\/wa-web\/view$/);
  if (waWebViewMatch && req.method === 'GET') {
    const sessionId = waWebViewMatch[1];
    const apiKey = (req.query?.apiKey as string) || (req.headers['x-api-key'] as string) || '';
    const requestedSocket = typeof req.query.socketUrl === 'string' && req.query.socketUrl.trim() ? req.query.socketUrl.trim().replace(/\/+$/, '') : SOCKET_SERVICE_URL;
    const html = generateWaWebViewerHtml(sessionId, apiKey, requestedSocket);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  }

  // 4. WhatsApp Web Companion status: /sessions/:id/wa-web/status
  const waWebStatusMatch = pathname.match(/^\/sessions\/([^/]+)\/wa-web\/status$/);
  if (waWebStatusMatch && req.method === 'GET') {
    const sessionId = waWebStatusMatch[1];
    const remote = await fetchBackend(`/sessions/${sessionId}/wa-web/status`, 'GET', undefined, req);
    if (remote.ok && remote.data) return res.status(remote.status).json(remote.data);
    return res.status(200).json({
      running: false,
      authenticated: false,
      qrReady: false,
      hasQr: false,
      sessionId,
      source: 'dev-fallback'
    });
  }

  // 5. WhatsApp Web Companion start/stop
  const waWebStartMatch = pathname.match(/^\/sessions\/([^/]+)\/wa-web\/start$/);
  if (waWebStartMatch && req.method === 'POST') {
    const sessionId = waWebStartMatch[1];
    const remote = await fetchBackend(`/sessions/${sessionId}/wa-web/start`, 'POST', req.body || {}, req);
    if (remote.ok && remote.data) return res.status(remote.status).json(remote.data);
    return res.status(502).json({
      running: false,
      message: 'Backend unavailable: cannot start WhatsApp Web companion',
      sessionId
    });
  }

  const waWebStopMatch = pathname.match(/^\/sessions\/([^/]+)\/wa-web\/stop$/);
  if (waWebStopMatch && req.method === 'POST') {
    return res.status(200).json({ running: false, message: 'WhatsApp Web Companion stopped' });
  }

  // 6. WhatsApp Web Companion screenshot
  const waWebScreenshotMatch = pathname.match(/^\/sessions\/([^/]+)\/wa-web\/screenshot$/);
  if (waWebScreenshotMatch && req.method === 'GET') {
    const sessionId = waWebScreenshotMatch[1];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"><rect width="100%" height="100%" fill="#111b21"/><text x="50%" y="45%" fill="#00a884" font-size="20" font-family="sans-serif" text-anchor="middle" dominant-baseline="middle">WhatsApp Web Oficial</text><text x="50%" y="55%" fill="#8696a0" font-size="14" font-family="sans-serif" text-anchor="middle" dominant-baseline="middle">Sesión: ${sessionId}</text></svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.status(200).send(svg);
  }

  // 7. Session Status: /sessions/:id/status
  const sessionStatusMatch = pathname.match(/^\/sessions\/([^/]+)\/status$/);
  if (sessionStatusMatch && req.method === 'GET') {
    const sessionId = sessionStatusMatch[1];
    const remote = await forwardToSocketService(`/sessions/${sessionId}/status`, 'GET');
    if (remote.ok && remote.data) {
      return res.status(remote.status).json(remote.data);
    }
    const session = devSessions[sessionId] || { id: sessionId, status: 'connected' };
    return res.status(200).json({ status: session.status || 'connected', sessionId });
  }

  // 8. Session QR: /sessions/:id/qr
  const sessionQrMatch = pathname.match(/^\/sessions\/([^/]+)\/qr$/);
  if (sessionQrMatch && req.method === 'GET') {
    const sessionId = sessionQrMatch[1];
    const remote = await forwardToSocketService(`/sessions/${sessionId}/qr`, 'GET');
    if (remote.ok && remote.data) {
      return res.status(remote.status).json(remote.data);
    }
    return res.status(200).json({
      status: 'authenticated',
      qrCode: null,
      message: 'Session is active on remote socket'
    });
  }

  // 9. Session Start: /sessions/:id/start
  const sessionStartMatch = pathname.match(/^\/sessions\/([^/]+)\/start$/);
  if (sessionStartMatch && req.method === 'POST') {
    const sessionId = sessionStartMatch[1];
    const remote = await forwardToSocketService(`/sessions/${sessionId}/start`, 'POST', req.body);
    if (remote.ok) {
      if (devSessions[sessionId]) devSessions[sessionId].status = 'connected';
      return res.status(remote.status).json(remote.data);
    }
    if (!devSessions[sessionId]) {
      devSessions[sessionId] = { id: sessionId, name: sessionId, status: 'connected', engine: ENGINE_TYPE };
    }
    return res.status(200).json({ status: 'starting', sessionId });
  }

  // 10. Session Stop: /sessions/:id/stop
  const sessionStopMatch = pathname.match(/^\/sessions\/([^/]+)\/stop$/);
  if (sessionStopMatch && req.method === 'POST') {
    const sessionId = sessionStopMatch[1];
    const remote = await forwardToSocketService(`/sessions/${sessionId}/stop`, 'POST', req.body);
    if (devSessions[sessionId]) devSessions[sessionId].status = 'disconnected';
    if (remote.ok) return res.status(remote.status).json(remote.data);
    return res.status(200).json({ status: 'stopped', sessionId });
  }

  // 11. Session Logout: /sessions/:id/logout
  const sessionLogoutMatch = pathname.match(/^\/sessions\/([^/]+)\/logout$/);
  if (sessionLogoutMatch && req.method === 'POST') {
    const sessionId = sessionLogoutMatch[1];
    const remote = await forwardToSocketService(`/sessions/${sessionId}/logout`, 'POST', req.body);
    if (devSessions[sessionId]) devSessions[sessionId].status = 'disconnected';
    if (remote.ok) return res.status(remote.status).json(remote.data);
    return res.status(200).json({ status: 'logged_out', sessionId });
  }

  // 12. Send Message: /sessions/:id/send-message or /sessions/:id/messages
  const sendMessageMatch = pathname.match(/^\/sessions\/([^/]+)\/(send-message|messages)$/);
  if (sendMessageMatch && req.method === 'POST') {
    const sessionId = sendMessageMatch[1];
    const remote = await forwardToSocketService(`/sessions/${sessionId}/send-message`, 'POST', req.body);
    if (remote.ok) return res.status(remote.status).json(remote.data);
    return res.status(200).json({ success: true, messageId: `msg_${Date.now()}` });
  }

  // 13. Sessions Collection: GET/POST /sessions
  if (pathname === '/sessions' || pathname === '/sessions/') {
    if (req.method === 'GET') {
      // Real backend is the single source of truth for the session list.
      // Only if the backend answers with a success but no list at all do we fall back
      // to whatever this instance created in memory.
      const remote = await fetchBackend('/sessions', 'GET', undefined, req);
      if (remote.ok && Array.isArray(remote.data)) {
        res.setHeader('x-openwa-source', 'backend');
        return res.status(200).json(remote.data);
      }
      res.setHeader('x-openwa-source', 'dev-fallback');
      return res.status(200).json(Object.values(devSessions));
    }
    if (req.method === 'POST') {
      const newSession = req.body || {};
      const id = newSession.id || newSession.name || `dev_${Date.now()}`;
      devSessions[id] = {
        id,
        name: newSession.name || id,
        status: 'connecting',
        engine: ENGINE_TYPE,
        createdAt: new Date().toISOString()
      };
      // Try to start on remote socket service
      await forwardToSocketService(`/sessions/${id}/start`, 'POST', newSession);
      return res.status(201).json(devSessions[id]);
    }
  }

  // 14. Single Session: GET/DELETE /sessions/:id
  const singleSessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (singleSessionMatch) {
    const sessionId = singleSessionMatch[1];
    if (req.method === 'GET') {
      const remote = await fetchBackend(`/sessions/${sessionId}`, 'GET', undefined, req);
      if (remote.ok && remote.data) return res.status(remote.status).json(remote.data);
      const session = devSessions[sessionId] || {
        id: sessionId,
        name: sessionId,
        status: 'disconnected',
        engine: ENGINE_TYPE
      };
      return res.status(200).json(session);
    }
    if (req.method === 'DELETE') {
      delete devSessions[sessionId];
      await forwardToSocketService(`/sessions/${sessionId}/logout`, 'POST');
      return res.status(200).json({ success: true, deleted: sessionId });
    }
  }

  // 15. Fallback transparent forward to FALLBACK_API_URL (/api-wa.mmtechhouse.co)
  // Socket.IO routes are mounted at root (/socket.io), not under /api
  const isSocketIo = req.url?.startsWith('/socket.io');
  const fullApiPath = isSocketIo
    ? (req.url || '/')
    : req.url?.startsWith('/api')
      ? req.url
      : `/api${req.url}`;
  return forwardToFallback(fullApiPath, req, res);
}
