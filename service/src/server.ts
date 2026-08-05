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
import { QuotaExceeded, findFigure, haveFigures, putFigure, removeBlob, usageFor } from "./figures.js";
import { tx } from "./db.js";
import type { Entry } from "../../src/ops.js";

const MAX_BODY = 4 * 1024 * 1024;
const here = path.dirname(fileURLToPath(import.meta.url));
// dist/service/src → service/public, and the viewer from the repo's public/.
const publicDir = path.resolve(here, "..", "..", "..", "public");
const viewerDir = path.resolve(here, "..", "..", "..", "..", "public");

type Ctx = { pool: Pool; req: http.IncomingMessage; res: http.ServerResponse; url: URL };

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
};

async function readBody(req: http.IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  return JSON.parse((await readBody(req)).toString("utf8") || "{}") as T;
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

export interface BootStatus {
  ready: boolean;
  bootError: string | null;
}

export function createServer(pool: Pool | null, status: () => BootStatus = () => ({ ready: true, bootError: null })): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Answered before anything else and without touching the database, so a
    // misconfigured deploy says what is wrong instead of timing out.
    if (url.pathname === "/health") {
      const s = status();
      if (!pool || !s.ready) {
        return json(res, 503, { ok: false, error: s.bootError ?? "starting" });
      }
      try {
        await pool.query("SELECT 1");
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 503, { ok: false, error: `database unreachable: ${(err as Error).message}` });
      }
    }

    if (!pool) return json(res, 503, { error: status().bootError ?? "service not configured" });

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

  // --- sign-in ---

  if (pathname === "/api/providers" && method === "GET") {
    return json(res, 200, { providers: configuredProviders() });
  }

  // --- operator endpoint ---
  //
  // Billing does not exist yet, so moving a user between plans is manual and
  // needs database access the operator may not have a route to. Gated on a
  // secret only the deploy holds: with ADMIN_TOKEN unset the route is not
  // merely forbidden, it does not exist.
  if (pathname === "/api/admin/plan" && method === "POST") {
    const secret = process.env.ADMIN_TOKEN;
    if (!secret) return json(res, 404, { error: "not found" });
    if (bearer(req) !== secret) return json(res, 401, { error: "unauthorized" });

    const body = await readJson<{ email?: string; plan?: string }>(req);
    if (!body.email || !body.plan) return json(res, 400, { error: "email and plan required" });
    // An unknown plan silently reads as free at check time, which would look
    // like the change had simply failed.
    if (!["free", "pro"].includes(body.plan)) return json(res, 400, { error: `unknown plan ${body.plan}` });

    const r = await pool.query<{ email: string; plan: string; storage_limit_bytes: string | null }>(
      "UPDATE users SET plan = $1 WHERE lower(email) = lower($2) RETURNING email, plan, storage_limit_bytes",
      [body.plan, body.email],
    );
    if (!r.rows.length) {
      const all = await pool.query<{ email: string; plan: string }>("SELECT email, plan FROM users ORDER BY created_at");
      return json(res, 404, { error: `no user with email ${body.email}`, known: all.rows });
    }
    return json(res, 200, { ok: true, user: r.rows[0] });
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

  // Pages and their assets are public; the data behind them is not. Gating
  // these too would 401 the very scripts that render the sign-in page.
  if (method === "GET" && !pathname.startsWith("/api/") && !isDataRoute(pathname) && !isFigureRoute(pathname)) {
    return serveStatic(res, pathname);
  }

  // --- everything below needs a principal ---

  const who = await principal(pool, req);
  if (!who) return json(res, 401, { error: "unauthorized" });

  if (pathname === "/api/me" && method === "GET") {
    const r = await pool.query("SELECT id, email, name, avatar_url FROM users WHERE id = $1", [who.userId]);
    return json(res, 200, { user: r.rows[0], via: who.via });
  }

  if (pathname === "/api/usage" && method === "GET") {
    return json(res, 200, await usageFor(pool, who.userId));
  }

  // --- figures ---
  //
  // The op log references a figure by filename only, so the bytes travel on
  // their own route. The viewer asks for /assets/<file>?chart=<id>, which is
  // the same URL shape the local viewer uses — public/ runs unchanged.

  if (isFigureRoute(pathname) && method === "GET") {
    const file = decodeURIComponent(pathname.slice("/assets/".length));
    const chartId = url.searchParams.get("chart") ?? (await firstChartFor(pool, who.userId));
    if (!chartId) return json(res, 404, { error: "not found" });
    if (!(await canAccessChart(pool, who.userId, chartId))) return json(res, 403, { error: "forbidden" });

    const blob = await findFigure(pool, chartId, file);
    if (!blob) return json(res, 404, { error: "not found" });
    res.writeHead(200, {
      "Content-Type": blob.mime,
      // Figure filenames carry a timestamp, so a given name is immutable.
      "Cache-Control": "private, max-age=31536000, immutable",
      // An SVG is a document: navigated to directly it would run its own
      // scripts on this origin. Figures are pixels here, never code.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="${path.basename(blob.path).replace(/[^\w.-]/g, "_")}"`,
    });
    fs.createReadStream(blob.path).pipe(res);
    return;
  }

  // Lets the agent upload only what is actually missing, so a resumed sync
  // does not re-send every blob it already pushed. Matched before the upload
  // route, whose filename pattern would otherwise swallow "missing".
  const figMissing = pathname.match(/^\/api\/charts\/([0-9a-f-]{36})\/figures\/missing$/i);
  if (figMissing && method === "POST") {
    const chartId = figMissing[1]!;
    if (!(await canAccessChart(pool, who.userId, chartId))) return json(res, 403, { error: "forbidden" });
    const body = await readJson<{ files?: string[] }>(req);
    const files = Array.isArray(body.files) ? body.files : [];
    const have = await haveFigures(pool, chartId, files);
    return json(res, 200, { missing: files.filter((f) => !have.has(f.split(/[/\\]/).pop()!)) });
  }

  const figUpload = pathname.match(/^\/api\/charts\/([0-9a-f-]{36})\/figures\/(.+)$/i);
  if (figUpload && method === "PUT") {
    const chartId = figUpload[1]!;
    if (!(await canAccessChart(pool, who.userId, chartId))) return json(res, 403, { error: "forbidden" });
    const file = decodeURIComponent(figUpload[2]!);
    const mime = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim();
    try {
      const stored = await putFigure(pool, chartId, file, mime, await readBody(req));
      return json(res, 200, stored);
    } catch (err) {
      // Distinct from a malformed upload: the agent should report this to the
      // user and stop retrying, not treat it as a transient failure.
      if (err instanceof QuotaExceeded) {
        return json(res, 507, { error: "storage quota exceeded", ...err.usage });
      }
      return json(res, 400, { error: (err as Error).message });
    }
  }

  // --- the viewer's own endpoints ---
  //
  // Same shapes the local viewer already fetches, so public/ runs unchanged
  // against the service: only the source of the graph differs.

  if (pathname === "/graph" && method === "GET") {
    const want = url.searchParams.get("chart");
    const chartId = want ?? (await firstChartFor(pool, who.userId));
    if (!chartId) return json(res, 404, { error: "no charts yet" });
    if (!(await canAccessChart(pool, who.userId, chartId))) return json(res, 403, { error: "forbidden" });
    const graph = await tx(pool, (c) => buildGraph(c, chartId));
    // Hosted charts are a window onto the agent's work, not an editor.
    return json(res, 200, { graph, readOnly: true });
  }

  if (pathname === "/charts" && method === "GET") {
    const r = await pool.query(
      `SELECT c.id AS "chartId", c.title, c.revision, c.updated_at,
              (SELECT count(*) FROM ops o WHERE o.chart_id = c.id) AS ops
         FROM charts c
         JOIN projects p ON p.id = c.project_id
        WHERE ${VISIBLE_TO}
        ORDER BY c.updated_at DESC LIMIT 200`,
      [who.userId],
    );
    const active = url.searchParams.get("chart");
    return json(
      res,
      200,
      r.rows.map((c) => ({
        chartId: c.chartId,
        title: c.title,
        nodes: Number(c.ops),
        active: c.chartId === active,
      })),
    );
  }

  if (pathname === "/config" && method === "GET") {
    // The vocabulary a chart was written under, so custom kinds still render.
    const want = url.searchParams.get("chart");
    let vocab: unknown = null;
    if (want && (await canAccessChart(pool, who.userId, want))) {
      const r = await pool.query<{ vocab: unknown }>("SELECT vocab FROM charts WHERE id = $1", [want]);
      vocab = r.rows[0]?.vocab ?? null;
    }
    return json(res, 200, vocab ? { vocab } : {});
  }

  if (pathname === "/whoami" && method === "GET") {
    const r = await pool.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [who.userId]);
    return json(res, 200, { project: r.rows[0]?.email ?? "skym", hosted: true });
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
      `SELECT c.id, c.slug, c.title, c.revision, c.updated_at, p.name AS project,
              (SELECT count(*) FROM ops o WHERE o.chart_id = c.id)::int AS ops
         FROM charts c
         JOIN projects p ON p.id = c.project_id
        WHERE ${VISIBLE_TO}
        ORDER BY c.updated_at DESC
        LIMIT 200`,
      [who.userId],
    );
    return json(res, 200, { charts: r.rows });
  }

  const chartDelete = pathname.match(/^\/api\/charts\/([0-9a-f-]{36})$/i);
  if (chartDelete && method === "DELETE") {
    const chartId = chartDelete[1]!;
    if (!(await canAccessChart(pool, who.userId, chartId))) return json(res, 403, { error: "forbidden" });
    await deleteChart(pool, chartId);
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "not found" });
}

/**
 * Drops a chart and reclaims its storage.
 *
 * Ops and figure rows go with the chart by cascade, but the blobs are on a
 * volume the database knows nothing about — without unlinking them here the
 * bytes would keep counting against the owner's quota forever. Files first:
 * a leftover row whose blob is gone is recoverable, a file with no row is not
 * attributable to anything and can never be cleaned up.
 */
async function deleteChart(pool: Pool, chartId: string): Promise<void> {
  const blobs = await pool.query<{ storage_key: string }>(
    "SELECT storage_key FROM figures WHERE chart_id = $1",
    [chartId],
  );
  for (const row of blobs.rows) removeBlob(row.storage_key);
  await pool.query("DELETE FROM charts WHERE id = $1", [chartId]);
}

/**
 * Charts $1 may see: theirs, or a project they were invited to.
 *
 * EXISTS rather than a LEFT JOIN on project_members. attachChart writes an
 * owner membership row for a project the user already owns, so a join matched
 * both arms of the OR and returned every chart once per membership — which is
 * why the dashboard listed each chart twice. A subquery cannot multiply rows.
 */
const VISIBLE_TO = `(
  p.owner_id = $1
  OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = $1)
)`;

/** Chart data the viewer fetches — public paths, private contents. */
const DATA_ROUTES = new Set(["/graph", "/charts", "/config", "/whoami", "/events"]);
const isDataRoute = (pathname: string): boolean => DATA_ROUTES.has(pathname);

/** Figure blobs are private: served only to someone who can see the chart. */
const isFigureRoute = (pathname: string): boolean => pathname.startsWith("/assets/");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/**
 * Two roots: the service's own pages, and the viewer, which is the same
 * public/ the local server ships so there is one chart UI, not two.
 */
/** Extensionless page URLs, so the nav links stay clean. */
const PAGES: Record<string, string> = {
  "/": "index.html",
  "/dashboard": "dashboard.html",
  "/settings": "settings.html",
  // The pairing URL printed in the terminal; settings is where the code goes.
  "/pair": "settings.html",
};

function serveStatic(res: http.ServerResponse, pathname: string): void {
  const rel = PAGES[pathname] ?? pathname.replace(/^\/+/, "");

  let file = path.join(publicDir, rel);
  const inService = file.startsWith(publicDir) && fs.existsSync(file) && fs.statSync(file).isFile();

  if (!inService) {
    // /chart renders the viewer; its assets resolve out of the same tree.
    const viewerRel = pathname === "/chart" ? "index.html" : rel;
    const candidate = path.join(viewerDir, viewerRel);
    if (candidate.startsWith(viewerDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      file = candidate;
    } else {
      file = path.join(publicDir, "index.html");
    }
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

/** Opening the viewer with no chart named lands on the most recent one. */
async function firstChartFor(pool: Pool, userId: string): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT c.id FROM charts c
       JOIN projects p ON p.id = c.project_id
      WHERE ${VISIBLE_TO}
      ORDER BY c.updated_at DESC LIMIT 1`,
    [userId],
  );
  return r.rows[0]?.id ?? null;
}

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
