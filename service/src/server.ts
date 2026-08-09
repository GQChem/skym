import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "./db.js";
import {
  approvePairing,
  canAccessChart,
  createSession,
  listAgentTokens,
  redeemPairing,
  revokeAgentToken,
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
import { recordAudit } from "./audit.js";
import { deleteAccount, exportAccount } from "./account.js";
import { cancelCommand, claimCommand, createCommand, listCommands, updateCommand } from "./commands.js";
import { applyStripeEvent, billingConfigured, constructStripeEvent, createCheckout, createPortal } from "./billing.js";
import type { Entry } from "../../src/ops.js";

// Matches the advertised per-figure ceiling. JSON routes impose their own
// semantic ceilings (notably the operation batch limit) after parsing.
const MAX_BODY = 8 * 1024 * 1024;
const MAX_OP_BATCH = 500;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
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

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

/** Per-instance brake; the deployment edge remains the distributed limiter. */
export function takeRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): number {
  if (rateBuckets.size > 10_000) {
    for (const [candidate, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(candidate);
    }
  }
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return 0;
  }
  if (bucket.count >= limit) return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  bucket.count += 1;
  return 0;
}

const clientAddress = (req: http.IncomingMessage): string => {
  const forwarded = req.headers["x-forwarded-for"];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0])?.trim()
    ?? req.socket.remoteAddress
    ?? "unknown";
};

const limited = (req: http.IncomingMessage, res: http.ServerResponse, scope: string, limit: number): boolean => {
  const retry = takeRateLimit(`${scope}:${clientAddress(req)}`, limit, 60_000);
  if (!retry) return false;
  res.setHeader("Retry-After", String(retry));
  json(res, 429, { error: "too many requests", retry_after: retry });
  return true;
};

function securityHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if ((req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

export interface ChartCursor { updatedAt: string; id: string }

export const encodeChartCursor = (cursor: ChartCursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");

export function decodeChartCursor(raw: string | null): ChartCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<ChartCursor>;
    if (!value.id || !value.updatedAt || !/^[0-9a-f-]{36}$/i.test(value.id) || !Number.isFinite(Date.parse(value.updatedAt))) return null;
    return { id: value.id, updatedAt: value.updatedAt };
  } catch {
    return null;
  }
}

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
    const requestId = randomUUID();
    const startedAt = Date.now();
    res.setHeader("X-Request-Id", requestId);
    securityHeaders(req, res);
    res.once("finish", () => {
      console.log(JSON.stringify({
        level: "info",
        event: "http_request",
        request_id: requestId,
        method: req.method ?? "GET",
        path: new URL(req.url ?? "/", "http://localhost").pathname,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
      }));
    });
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

  // Stripe signatures cover the exact raw bytes, so this must run before any
  // JSON parser touches the request body.
  if (pathname === "/api/billing/webhook" && method === "POST") {
    const signature = req.headers["stripe-signature"];
    if (!signature || Array.isArray(signature)) return json(res, 400, { error: "missing Stripe signature" });
    let event;
    try {
      event = constructStripeEvent(await readBody(req, 1024 * 1024), signature);
    } catch (err) {
      console.warn(JSON.stringify({
        level: "warn",
        event: "stripe_webhook_signature_rejected",
        error: (err as Error).message,
      }));
      return json(res, 400, { error: "invalid Stripe webhook signature" });
    }
    try {
      await applyStripeEvent(pool, event);
      return json(res, 200, { received: true });
    } catch (err) {
      console.error(JSON.stringify({
        level: "error",
        event: "stripe_webhook_processing_failed",
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        error: (err as Error).message,
      }));
      return json(res, 500, { error: "Stripe webhook processing failed" });
    }
  }

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
    await recordAudit(pool, {
      event: "plan.changed", targetType: "user", targetId: r.rows[0]!.email,
      metadata: { plan: body.plan },
    });
    return json(res, 200, { ok: true, user: r.rows[0] });
  }

  // Read-only counterpart, for diagnosing what is actually in the database
  // when the UI and the code disagree about it.
  if (pathname === "/api/admin/charts" && method === "GET") {
    const secret = process.env.ADMIN_TOKEN;
    if (!secret) return json(res, 404, { error: "not found" });
    if (bearer(req) !== secret) return json(res, 401, { error: "unauthorized" });

    const r = await pool.query(
      `SELECT c.id, c.slug, c.title, c.revision, p.name AS project, u.email AS owner,
              (SELECT count(*) FROM ops o WHERE o.chart_id = c.id)::int AS ops
         FROM charts c
         JOIN projects p ON p.id = c.project_id
         JOIN users u ON u.id = p.owner_id
        ORDER BY c.title, c.updated_at DESC`,
    );
    return json(res, 200, { count: r.rows.length, charts: r.rows });
  }

  // The integration tests create a project per run and never clean up, so a
  // production run leaves its scaffolding behind for good. Matches only the
  // generated name, and reports what it would remove unless told to commit.
  if (pathname === "/api/admin/purge-test-projects" && method === "POST") {
    const secret = process.env.ADMIN_TOKEN;
    if (!secret) return json(res, 404, { error: "not found" });
    if (bearer(req) !== secret) return json(res, 401, { error: "unauthorized" });

    const body = await readJson<{ confirm?: boolean }>(req);
    const doomed = await pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM projects WHERE name ~ '^(skym-)?proj-[A-Za-z0-9]{6,8}$'",
    );
    if (!body.confirm) {
      return json(res, 200, { dryRun: true, projects: doomed.rows.length, names: doomed.rows.map((p) => p.name) });
    }

    // Blobs first: charts cascade from the project, and a figure row that
    // vanishes with its chart would strand its bytes on the volume forever.
    const ids = doomed.rows.map((p) => p.id);
    if (ids.length) {
      const blobs = await pool.query<{ storage_key: string }>(
        `SELECT f.storage_key FROM figures f
           JOIN charts c ON c.id = f.chart_id
          WHERE c.project_id = ANY($1::uuid[])`,
        [ids],
      );
      for (const b of blobs.rows) removeBlob(b.storage_key);
      await pool.query("DELETE FROM projects WHERE id = ANY($1::uuid[])", [ids]);
    }
    return json(res, 200, { deleted: ids.length });
  }

  const authStart = pathname.match(/^\/auth\/(google|github)$/);
  if (authStart && method === "GET") {
    if (limited(req, res, "oauth-start", 30)) return;
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
    if (limited(req, res, "pair-start", 10)) return;
    const p = await startPairing(pool);
    return json(res, 200, {
      device_code: p.deviceCode,
      user_code: p.userCode,
      expires_in: p.expiresIn,
      verification_uri: `${publicUrl(req)}/pair`,
    });
  }

  if (pathname === "/api/pair/poll" && method === "POST") {
    if (limited(req, res, "pair-poll", 120)) return;
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
    if (ok) await recordAudit(pool, { actorId: who.userId, event: "pairing.approved", targetType: "pairing" });
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

  if (pathname === "/api/billing" && method === "GET") {
    if (who.via !== "session") return json(res, 403, { error: "browser session required" });
    const account = await pool.query(
      "SELECT plan, subscription_status, (stripe_customer_id IS NOT NULL) AS has_customer FROM users WHERE id = $1",
      [who.userId],
    );
    return json(res, 200, { configured: billingConfigured(), ...account.rows[0] });
  }
  if (pathname === "/api/billing/checkout" && method === "POST") {
    if (who.via !== "session") return json(res, 403, { error: "browser session required" });
    if (!billingConfigured()) return json(res, 503, { error: "billing is not configured" });
    return json(res, 200, { url: await createCheckout(pool, who.userId, publicUrl(req)) });
  }
  if (pathname === "/api/billing/portal" && method === "POST") {
    if (who.via !== "session") return json(res, 403, { error: "browser session required" });
    if (!billingConfigured()) return json(res, 503, { error: "billing is not configured" });
    return json(res, 200, { url: await createPortal(pool, who.userId, publicUrl(req)) });
  }

  if (pathname === "/api/agents" && method === "GET") {
    if (who.via !== "session") return json(res, 403, { error: "browser session required" });
    return json(res, 200, { agents: await listAgentTokens(pool, who.userId) });
  }

  const agentDelete = pathname.match(/^\/api\/agents\/([0-9a-f-]{36})$/i);
  if (agentDelete && method === "DELETE") {
    if (who.via !== "session") return json(res, 403, { error: "browser session required" });
    const removed = await revokeAgentToken(pool, who.userId, agentDelete[1]!);
    if (removed) await recordAudit(pool, {
      actorId: who.userId, event: "agent.revoked", targetType: "agent_token", targetId: agentDelete[1]!,
    });
    return json(res, removed ? 200 : 404, removed ? { ok: true } : { error: "not found" });
  }

  if (pathname === "/api/account/export" && method === "GET") {
    if (who.via !== "session") return json(res, 403, { error: "browser session required" });
    res.setHeader("Content-Disposition", `attachment; filename="skym-export-${new Date().toISOString().slice(0, 10)}.json"`);
    await recordAudit(pool, { actorId: who.userId, event: "account.exported", targetType: "user", targetId: who.userId });
    return json(res, 200, await exportAccount(pool, who.userId));
  }

  if (pathname === "/api/account" && method === "DELETE") {
    if (who.via !== "session") return json(res, 403, { error: "browser session required" });
    const body = await readJson<{ confirmation?: string }>(req);
    if (body.confirmation !== "DELETE") return json(res, 400, { error: "confirmation must be DELETE" });
    const blobs = await deleteAccount(pool, who.userId);
    for (const key of blobs) removeBlob(key);
    res.setHeader("Set-Cookie", clearedCookie(req));
    return json(res, 200, { ok: true });
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
    const inline = blob.mime.startsWith("image/");
    res.writeHead(200, {
      "Content-Type": blob.mime,
      // Figure filenames carry a timestamp, so a given name is immutable.
      "Cache-Control": "private, max-age=31536000, immutable",
      // An SVG is a document: navigated to directly it would run its own
      // scripts on this origin. Figures are pixels here, never code.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${path.basename(blob.path).replace(/[^\w.-]/g, "_")}"`,
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
    if (who.via !== "agent") return json(res, 403, { error: "agent credential required" });
    if (!(await canAccessChart(pool, who.userId, chartId, "write"))) return json(res, 403, { error: "forbidden" });
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

  if (pathname === "/events" && method === "GET") {
    const want = url.searchParams.get("chart");
    const chartId = want ?? (await firstChartFor(pool, who.userId));
    if (!chartId) return json(res, 404, { error: "no charts yet" });
    if (!(await canAccessChart(pool, who.userId, chartId))) return json(res, 403, { error: "forbidden" });
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    let lastRevision = -1;
    let sending = false;
    const send = async () => {
      if (sending || res.destroyed) return;
      sending = true;
      try {
        const meta = await pool.query<{ revision: string }>("SELECT revision FROM charts WHERE id = $1", [chartId]);
        const revision = Number(meta.rows[0]?.revision ?? -1);
        if (revision !== lastRevision) {
          const graph = await tx(pool, (c) => buildGraph(c, chartId));
          res.write(`data: ${JSON.stringify({ graph, readOnly: true, commandsEnabled: true, chartId })}\n\n`);
          lastRevision = revision;
        } else {
          res.write(": keepalive\n\n");
        }
      } finally {
        sending = false;
      }
    };
    await send();
    const timer = setInterval(() => void send().catch(() => {}), 2_000);
    timer.unref();
    req.once("close", () => clearInterval(timer));
    return;
  }

  if (pathname === "/graph" && method === "GET") {
    const want = url.searchParams.get("chart");
    const chartId = want ?? (await firstChartFor(pool, who.userId));
    if (!chartId) return json(res, 404, { error: "no charts yet" });
    if (!(await canAccessChart(pool, who.userId, chartId))) return json(res, 403, { error: "forbidden" });
    const graph = await tx(pool, (c) => buildGraph(c, chartId));
    return json(res, 200, { graph, readOnly: true, commandsEnabled: true, chartId });
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

  const commandCollection = pathname.match(/^\/api\/charts\/([0-9a-f-]{36})\/commands$/i);
  if (commandCollection) {
    const chartId = commandCollection[1]!;
    if (!(await canAccessChart(pool, who.userId, chartId))) return json(res, 403, { error: "forbidden" });
    if (method === "GET") return json(res, 200, { commands: await listCommands(pool, chartId) });
    if (method === "POST") {
      if (who.via !== "session") return json(res, 403, { error: "browser session required" });
      if (!(await canAccessChart(pool, who.userId, chartId, "write"))) return json(res, 403, { error: "forbidden" });
      const body = await readJson<{ node_id?: string; verb?: string; body?: string; idempotency_key?: string }>(req);
      if (body.body && body.body.length > 4_000) return json(res, 413, { error: "command body exceeds 4000 characters" });
      if (body.node_id && body.node_id.length > 200) return json(res, 400, { error: "node_id too long" });
      const command = await createCommand(pool, {
        chartId, userId: who.userId, nodeId: body.node_id, verb: body.verb, body: body.body,
        idempotencyKey: body.idempotency_key,
      });
      return json(res, 201, { command });
    }
  }

  const commandClaim = pathname.match(/^\/api\/charts\/([0-9a-f-]{36})\/commands\/claim$/i);
  if (commandClaim && method === "POST") {
    const chartId = commandClaim[1]!;
    if (who.via !== "agent" || !who.agentId) return json(res, 403, { error: "agent credential required" });
    if (!(await canAccessChart(pool, who.userId, chartId, "write"))) return json(res, 403, { error: "forbidden" });
    return json(res, 200, { command: await claimCommand(pool, chartId, who.agentId) });
  }

  const commandItem = pathname.match(/^\/api\/commands\/([0-9a-f-]{36})$/i);
  if (commandItem && method === "PATCH") {
    if (who.via !== "agent" || !who.agentId) return json(res, 403, { error: "agent credential required" });
    const body = await readJson<{ status?: "running" | "done" | "failed"; result?: string }>(req);
    if (!body.status || !["running", "done", "failed"].includes(body.status)) return json(res, 400, { error: "invalid status" });
    if (body.result && body.result.length > 8_000) return json(res, 413, { error: "result exceeds 8000 characters" });
    const command = await updateCommand(pool, commandItem[1]!, who.agentId, body.status, body.result);
    return json(res, command ? 200 : 409, command ? { command } : { error: "command is not claimed by this agent" });
  }
  if (commandItem && method === "DELETE") {
    if (who.via !== "session") return json(res, 403, { error: "browser session required" });
    const cancelled = await cancelCommand(pool, commandItem[1]!, who.userId);
    return json(res, cancelled ? 200 : 409, cancelled ? { ok: true } : { error: "command cannot be cancelled" });
  }

  // Attach a chart by repo key, creating the project on first sight. This is
  // what lets an agent sync without the user setting anything up first.
  if (pathname === "/api/charts/attach" && method === "POST") {
    if (who.via !== "agent") return json(res, 403, { error: "agent credential required" });
    const body = await readJson<{ repo_key?: string; project_name?: string; slug?: string; title?: string; vocab?: unknown }>(req);
    if (!body.slug) return json(res, 400, { error: "slug required" });
    const out = await attachChart(pool, who.userId, body);
    return json(res, 200, out);
  }

  const opsMatch = pathname.match(/^\/api\/charts\/([0-9a-f-]{36})\/ops$/i);
  if (opsMatch) {
    const chartId = opsMatch[1]!;
    if (!(await canAccessChart(pool, who.userId, chartId))) return json(res, 403, { error: "forbidden" });

    if (method === "POST") {
      if (limited(req, res, "ops", 120)) return;
      if (who.via !== "agent") return json(res, 403, { error: "agent credential required" });
      if (!(await canAccessChart(pool, who.userId, chartId, "write"))) return json(res, 403, { error: "forbidden" });
      const body = await readJson<{ ops?: Entry[] }>(req);
      if (!Array.isArray(body.ops)) return json(res, 400, { error: "ops[] required" });
      if (body.ops.length > MAX_OP_BATCH) return json(res, 413, { error: `at most ${MAX_OP_BATCH} ops per batch` });
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
    return json(res, 200, { graph, readOnly: who.via === "session", commandsEnabled: who.via === "session", chartId });
  }

  if (pathname === "/api/charts" && method === "GET") {
    const requested = Number(url.searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);
    const limit = Number.isInteger(requested) ? Math.max(1, Math.min(MAX_PAGE_SIZE, requested)) : DEFAULT_PAGE_SIZE;
    const cursorRaw = url.searchParams.get("cursor");
    const cursor = decodeChartCursor(cursorRaw);
    if (cursorRaw && !cursor) return json(res, 400, { error: "invalid cursor" });
    const cursorWhere = cursor ? "AND (c.updated_at, c.id) < ($2::timestamptz, $3::uuid)" : "";
    const params = cursor
      ? [who.userId, cursor.updatedAt, cursor.id, limit + 1]
      : [who.userId, limit + 1];
    const limitParam = cursor ? "$4" : "$2";
    const r = await pool.query<{
      id: string; slug: string; title: string; revision: string; updated_at: Date; project: string; ops: number;
    }>(
      `SELECT c.id, c.slug, c.title, c.revision, c.updated_at, p.name AS project,
              (SELECT count(*) FROM ops o WHERE o.chart_id = c.id)::int AS ops
         FROM charts c
         JOIN projects p ON p.id = c.project_id
        WHERE ${VISIBLE_TO}
          ${cursorWhere}
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT ${limitParam}`,
      params,
    );
    const hasMore = r.rows.length > limit;
    const charts = r.rows.slice(0, limit);
    const last = charts.at(-1);
    const nextCursor = hasMore && last
      ? encodeChartCursor({ updatedAt: new Date(last.updated_at).toISOString(), id: last.id })
      : null;
    return json(res, 200, { charts, next_cursor: nextCursor });
  }

  const chartDelete = pathname.match(/^\/api\/charts\/([0-9a-f-]{36})$/i);
  if (chartDelete && method === "DELETE") {
    const chartId = chartDelete[1]!;
    if (who.via !== "session") return json(res, 403, { error: "browser session required" });
    if (!(await canAccessChart(pool, who.userId, chartId, "delete"))) return json(res, 403, { error: "forbidden" });
    await deleteChart(pool, chartId, who.userId);
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
async function deleteChart(pool: Pool, chartId: string, actorId: string): Promise<void> {
  const keys = await tx(pool, async (client) => {
    const blobs = await client.query<{ storage_key: string }>(
      "SELECT storage_key FROM figures WHERE chart_id = $1", [chartId],
    );
    await recordAudit(client, { actorId, event: "chart.deleted", targetType: "chart", targetId: chartId });
    await client.query("DELETE FROM charts WHERE id = $1", [chartId]);
    return blobs.rows.map((row) => row.storage_key);
  });
  // Database first: a failed unlink leaves an orphan that reconciliation can
  // remove, never a live chart whose evidence has silently disappeared.
  for (const key of keys) removeBlob(key);
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
  "/privacy": "privacy.html",
  "/terms": "terms.html",
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
  body: { repo_key?: string; project_name?: string; slug?: string; title?: string; vocab?: unknown },
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
      `INSERT INTO charts (project_id, slug, title, vocab) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, slug) DO UPDATE SET title = EXCLUDED.title,
         vocab = COALESCE(EXCLUDED.vocab, charts.vocab), updated_at = now()
       RETURNING id, revision`,
      [projectId, body.slug, body.title ?? body.slug, body.vocab ?? null],
    );
    const row = chart.rows[0]!;
    return { chartId: row.id, projectId, revision: Number(row.revision) };
  });
}
