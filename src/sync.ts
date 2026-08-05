import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry } from "./ops.js";

/**
 * Ships ops to the service without ever blocking a tool call.
 *
 * `commit()` is synchronous and every mutator funnels through it, so making
 * the push awaited would turn all twelve handlers async. Instead ops land in
 * an in-memory queue and a timer drains it: a tool call returns at local
 * speed, and the network is somebody else's problem.
 *
 * The queue is best-effort by design. A failed flush retries with backoff and
 * keeps its ops; if the process dies with the queue non-empty, the local log
 * is still on disk and the next run resends from the server's revision. Ops
 * carry ids, so re-sending is free of consequence.
 */

const CREDS_FILE = path.join(os.homedir(), ".skym", "credentials.json");

export interface Credentials {
  url: string;
  token: string;
}

export function readCredentials(): Credentials | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDS_FILE, "utf8")) as Partial<Credentials>;
    return raw.url && raw.token ? { url: raw.url, token: raw.token } : null;
  } catch {
    return null;
  }
}

export function writeCredentials(creds: Credentials): void {
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), "utf8");
  // The token is a bearer credential: keep it off other users' eyes where the
  // platform supports it. Windows ignores the mode, which is why this is
  // best-effort rather than a guarantee.
  try {
    fs.chmodSync(CREDS_FILE, 0o600);
  } catch {
    /* not POSIX */
  }
}

export interface SyncOptions {
  url: string;
  token: string;
  chartId: string;
  /** Called when a flush fails for good, so the caller can surface it once. */
  onError?: (err: Error) => void;
  flushMs?: number;
  fetchImpl?: typeof fetch;
}

interface AttachInput {
  repoKey?: string;
  projectName?: string;
  slug: string;
  title: string;
}

export class SyncClient {
  private queue: Entry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private failures = 0;
  private remoteChartId: string | null = null;
  private readonly fetchImpl: typeof fetch;

  /** Last error, so `flow_show` can report a degraded sync without spamming. */
  lastError: string | null = null;

  constructor(private opts: SyncOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Resolves the remote chart, creating the project on first sight. */
  async attach(input: AttachInput): Promise<string> {
    const body = await this.call<{ chartId: string }>("POST", "/api/charts/attach", {
      repo_key: input.repoKey,
      project_name: input.projectName,
      slug: input.slug,
      title: input.title,
    });
    this.remoteChartId = body.chartId;
    return body.chartId;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.opts.flushMs ?? 2000);
    this.timer.unref?.();
  }

  /** Never throws and never awaits: this runs inside a synchronous commit. */
  enqueue(entry: Entry): void {
    this.queue.push(entry);
    this.start();
  }

  get pending(): number {
    return this.queue.length;
  }

  async flush(): Promise<void> {
    if (this.flushing || !this.queue.length || !this.remoteChartId) return;
    this.flushing = true;
    // Take the batch, but keep it until the server confirms.
    const batch = this.queue.slice();
    try {
      await this.call(`POST`, `/api/charts/${this.remoteChartId}/ops`, { ops: batch });
      this.queue.splice(0, batch.length);
      this.failures = 0;
      this.lastError = null;
    } catch (err) {
      this.failures += 1;
      this.lastError = (err as Error).message;
      // Back off to a minute so a dead service does not spin the timer.
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        const delay = Math.min(60_000, (this.opts.flushMs ?? 2000) * 2 ** Math.min(this.failures, 5));
        const t = setTimeout(() => {
          this.timer = null;
          this.start();
        }, delay);
        t.unref?.();
      }
      this.opts.onError?.(err as Error);
    } finally {
      this.flushing = false;
    }
  }

  /** Drains what is queued; called on shutdown so a last op is not lost. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush().catch(() => {});
  }

  private async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(new URL(route, this.opts.url).toString(), {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.opts.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${method} ${route} failed: ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`);
    }
    return (await res.json()) as T;
  }
}

// --- device-code pairing, the first-run flow ---

export interface PairingPrompt {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  expiresIn: number;
}

const PENDING_FILE = path.join(os.homedir(), ".skym", "pending-pairing.json");

/**
 * A device code outlives the process that asked for it.
 *
 * Approval happens in a browser on the user's own schedule, and the agent
 * process may well have exited by then — a chat ends, Claude Code restarts.
 * Persisting the code means the next process redeems it instead of minting a
 * fresh one the user has to approve all over again.
 */
export function readPendingPairing(): PairingPrompt | null {
  try {
    const raw = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")) as PairingPrompt & { at?: number };
    // Server-side expiry is authoritative; this just avoids a pointless call.
    if (raw.at && Date.now() - raw.at > raw.expiresIn * 1000) return null;
    return raw.deviceCode ? raw : null;
  } catch {
    return null;
  }
}

export function writePendingPairing(p: PairingPrompt): void {
  fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
  fs.writeFileSync(PENDING_FILE, JSON.stringify({ ...p, at: Date.now() }, null, 2), "utf8");
}

export function clearPendingPairing(): void {
  try {
    fs.rmSync(PENDING_FILE, { force: true });
  } catch {
    /* already gone */
  }
}

/** One poll, not a loop: called on each tool call so approval lands eventually. */
export async function tryRedeem(
  url: string,
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: "pending" | "expired" | "ready"; token?: string }> {
  const res = await fetchImpl(new URL("/api/pair/poll", url).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  if (res.status === 410) return { status: "expired" };
  if (!res.ok) return { status: "pending" };
  const body = (await res.json()) as { status: string; token?: string };
  return body.status === "ready" && body.token ? { status: "ready", token: body.token } : { status: "pending" };
}

export async function startPairing(url: string, fetchImpl: typeof fetch = fetch): Promise<PairingPrompt> {
  const res = await fetchImpl(new URL("/api/pair/start", url).toString(), { method: "POST" });
  if (!res.ok) throw new Error(`pairing failed to start: ${res.status}`);
  const body = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
  };
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresIn: body.expires_in,
  };
}

/** Polls until the user approves in a browser, or the code expires. */
export async function awaitPairing(
  url: string,
  deviceCode: string,
  opts: { intervalMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const interval = opts.intervalMs ?? 2000;
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);

  while (Date.now() < deadline) {
    const res = await fetchImpl(new URL("/api/pair/poll", url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
    });
    if (res.status === 410) throw new Error("pairing code expired; run the pairing again");
    if (res.ok) {
      const body = (await res.json()) as { status: string; token?: string };
      if (body.status === "ready" && body.token) return body.token;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("pairing timed out");
}
