import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "./db.js";
import {
  approvePairing,
  canAccessChart,
  createSession,
  redeemPairing,
  resolveAgentToken,
  hashToken,
  resolveSession,
  startPairing,
  upsertIdentity,
  type Principal,
} from "./auth.js";
import {
  authorizeUrl,
  configuredProviders,
  exchangeCode,
  fetchProfile,
  isConfigured,
  signState,
  verifyState,
  type ProviderName,
} from "./oauth.js";
import { buildGraph, ingest } from "./ingest.js";
import { tx } from "./db.js";
import type { Entry } from "skym-flow/ops";

const MAX_BODY = 4 * 1024 * 1024;
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

type Ctx = { pool: Pool; req: http.IncomingMessage; res: http.ServerResponse; url: URL };

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
};

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
}

const bearer = (req: http.IncomingMessage): string | null => {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
};

const cookie = (req: http.IncomingMessage, name: string): string | null => {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
};

/** Session cookie or agent bearer token; both resolve to the same principal. */
async function principal(pool: Pool, req: http.IncomingMessage): Promise<Principal | null> {
  const token = bearer(req);
  if (token) return resolveAgentToken(pool, token);
  const sid = cookie(req, "skym_session");
  return sid ? resolveSession(pool, sid) : null;
}

export function createServer(pool: Pool): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const ctx: Ctx = { pool, req, res, url };
    try {
      await route(ctx);
    } catch (err) {
      const msg = (err as Error).message;
      // Never surface a stack or a driver message to the caller.
      json(res, 500, { error: msg.includes("body too large") ? msg : "internal error" });
    }
  });
}

async function route({ pool, req, res, url }: Ctx): Promise<void> {
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (pathname === "/health") {
    await pool.query("SELECT 1");
    return json(res, 200, { ok: true });
  }

  // --- sign-in ---

  if (pathname === "/api/providers" && method === "GET") {
    return json(res, 200, { providers: configuredProviders() });
  }

  const authStart = pathname.match(/^\/auth\/(google|github)$/);
  if (authStart && method === "GET") {
    const name = authStart[1] as ProviderName;
    if (!isConfigured(name)) return json(res, 501, { error: `${name} sign-in is not configured` });
    const state = signState(url.searchParams.get("return_to") ?? "/");
    const to = authorizeUrl(name, callbackUrl(req, name), state);
    res.writeHead(302, { Location: to, "Cache-Control": "no-store" }).end();
    return;
  }

  const authCallback = pathname.match(/^\/auth\/(google|github)\/callback$/);
  if (authCallback && method === "GET") {
    const name = authCallback[1] as ProviderName;
    if (!isConfigured(name)) return json(res, 501, { error: `${name} sign-in is not configured` });

    const denied = url.searchParams.get("error");
    if (denied) return redirect(res, `/?error=${encodeURIComponent(denied)}`);

    const { ok, returnTo } = verifyState(url.searchParams.get("state"));
    if (!ok) return json(res, 400, { error: "bad state" });

    const code = url.searchParams.get("code");
    if (!code) return json(res, 400, { error: "no code" });

    const token = await exchangeCode(name, code, callbackUrl(req, name));
    const profile = await fetchProfile(name, token);
    const userId = await upsertIdentity(pool, name, profile.providerUserId, profile.email, profile.emailVerified, {
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });
    const session = await createSession(pool, userId);
    res
      .writeHead(302, {
        Location: returnTo,
        "Set-Cookie": sessionCookie(req, session),
        "Cache-Control": "no-store",
      })
      .end();
    return;
  }

  if (pathname === "/auth/logout" && method === "POST") {
    const sid = cookie(req, "skym_session");
    if (sid) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(sid)]);
    res.writeHead(302, { Location: "/", "Set-Cookie": clearedCookie(req) }).end();
    return;
  }

  // --- device-code pairing (unauthenticated by design) ---

  if (pathname === "/api/pair/start" && method === "POST") {
    const p = await startPairing(pool);
    return json(res, 200, {
      device_code: p.deviceCode,
      user_code: p.userCode,
      expires_in: p.expiresIn,
      verification_uri: `${publicUrl(req)}/pair`,
    });
  }

  if (pathname === "/api/pair/poll" && method === "POST") {
    const body = await readJson<{ device_code?: string }>(req);
    if (!body.device_code) return json(res, 400, { error: "device_code required" });
    const out = await redeemPairing(pool, body.device_code);
    if (out.status === "ready") return json(res, 200, { status: "ready", token: out.token });
    return json(res, out.status === "expired" ? 410 : 202, { status: out.status });
  }

  if (pathname === "/api/pair/approve" && method === "POST") {
    const who = await principal(pool, req);
    if (!who) return json(res, 401, { error: "sign in first" });
    const body = await readJson<{ user_code?: string }>(req);
    if (!body.user_code) return json(res, 400, { error: "user_code required" });
    const ok = await approvePairing(pool, body.user_code, who.userId);
    return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "unknown or expired code" });
  }

  // --- everything below needs a principal ---

  const who = await principal(pool, req);
  if (!who) return json(res, 401, { error: "unauthorized" });

  if (pathname === "/api/me" && method === "GET") {
    const r = await pool.query("SELECT id, email, name, avatar_url FROM users WHERE id = $1", [who.userId]);
    return json(res, 200, { user: r.rows[0], via: who.via });
  }

  // Attach a chart by repo key, creating the project on first sight. This is
  // what lets an agent sync without the user setting anything up first.
  if (pathname === "/api/charts/attach" && method === "POST") {
    const body = await readJson<{ repo_key?: string; project_name?: string; slug?: string; title?: string }>(req);
    if (!body.slug) return json(res, 400, { error: "slug required" });
    const out = await attachChart(pool, who.userId, body);
    return json(res, 200, out);
  }

  const opsMatch = pathname.match(/^\/api\/charts\/([0-9a-f-]{36})\/ops$/i);
  if (opsMatch) {
    const chartId = opsMatch[1]!;
    if (!(await canAccessChart(pool, who.userId, chartId))) return json(res, 403, { error: "forbidden" });

    if (method === "POST") {
      const body = await readJson<{ ops?: Entry[] }>(req);
      if (!Array.isArray(body.ops)) return json(res, 400, { error: "ops[] required" });
      const result = await ingest(pool, chartId, body.ops, who.userId);
      return json(res, 200, result);
    }
    if (method === "GET") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const r = await pool.query(
        "SELECT seq, op_id, at, author, op FROM ops WHERE chart_id = $1 AND seq > $2 ORDER BY seq ASC",
        [chartId, since],
      );
      return json(res, 200, {
        ops: r.rows.map((o) => ({ id: o.op_id, seq: Number(o.seq), at: Number(o.at), by: o.author, op: o.op })),
      });
    }
  }

  const graphMatch = pathname.match(/^\/api\/charts\/([0-9a-f-]{36})\/graph$/i);
  if (graphMatch && method === "GET") {
    const chartId = graphMatch[1]!;
    if (!(await canAccessChart(pool, who.userId, chartId))) return json(res, 403, { error: "forbidden" });
    const graph = await tx(pool, (c) => buildGraph(c, chartId));
    return json(res, 200, { graph, readOnly: who.via === "session" });
  }

  if (pathname === "/api/charts" && method === "GET") {
    const r = await pool.query(
      `SELECT c.id, c.slug, c.title, c.revision, c.updated_at, p.name AS project
         FROM charts c
         JOIN projects p ON p.id = c.project_id
         LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
        WHERE p.owner_id = $1 OR m.user_id IS NOT NULL
        ORDER BY c.updated_at DESC
        LIMIT 200`,
      [who.userId],
    );
    return json(res, 200, { charts: r.rows });
  }

  if (method === "GET" && !pathname.startsWith("/api/")) return serveStatic(res, pathname);
  json(res, 404, { error: "not found" });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** `/pair` and any unknown path fall back to the single page. */
function serveStatic(res: http.ServerResponse, pathname: string): void {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let file = path.join(publicDir, rel);
  if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    file = path.join(publicDir, "index.html");
  }
  if (!fs.existsSync(file)) return json(res, 404, { error: "not found" });
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(file).pipe(res);
}

/** Honours the proxy header Railway sets, so pairing URLs are https. */
function publicUrl(req: http.IncomingMessage): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "http";
  return process.env.PUBLIC_URL ?? `${proto}://${req.headers.host}`;
}

/** Must match the callback registered with the provider, exactly. */
const callbackUrl = (req: http.IncomingMessage, name: ProviderName): string =>
  `${publicUrl(req)}/auth/${name}/callback`;

const isHttps = (req: http.IncomingMessage): boolean => publicUrl(req).startsWith("https://");

/**
 * Lax rather than Strict: the OAuth callback is a top-level cross-site
 * navigation, and Strict would withhold the cookie on that first hop.
 */
function sessionCookie(req: http.IncomingMessage, token: string): string {
  const parts = [
    `skym_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${30 * 24 * 60 * 60}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

const clearedCookie = (req: http.IncomingMessage): string =>
  `skym_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? "; Secure" : ""}`;

const redirect = (res: http.ServerResponse, to: string): void => {
  res.writeHead(302, { Location: to, "Cache-Control": "no-store" }).end();
};

async function attachChart(
  pool: Pool,
  userId: string,
  body: { repo_key?: string; project_name?: string; slug?: string; title?: string },
): Promise<{ chartId: string; projectId: string; revision: number }> {
  return tx(pool, async (c) => {
    let projectId: string | undefined;

    if (body.repo_key) {
      const found = await c.query<{ id: string }>(
        "SELECT id FROM projects WHERE owner_id = $1 AND repo_key = $2",
        [userId, body.repo_key],
      );
      projectId = found.rows[0]?.id;
    }

    if (!projectId) {
      const created = await c.query<{ id: string }>(
        "INSERT INTO projects (name, repo_key, owner_id) VALUES ($1, $2, $3) RETURNING id",
        [body.project_name ?? body.repo_key ?? "Untitled project", body.repo_key ?? null, userId],
      );
      projectId = created.rows[0]!.id;
      await c.query(
        "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
        [projectId, userId],
      );
    }

    const chart = await c.query<{ id: string; revision: string }>(
      `INSERT INTO charts (project_id, slug, title) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, slug) DO UPDATE SET title = EXCLUDED.title, updated_at = now()
       RETURNING id, revision`,
      [projectId, body.slug, body.title ?? body.slug],
    );
    const row = chart.rows[0]!;
    return { chartId: row.id, projectId, revision: Number(row.revision) };
  });
}
