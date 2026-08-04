import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Google and GitHub sign-in. Both reduce to the same three steps — redirect
 * with a state, exchange the code, fetch a profile — so the difference is
 * confined to the provider table below.
 *
 * Two things are load-bearing:
 *  - `state` is signed, not stored. A stateless CSRF token means no session
 *    before login and no row to clean up, and a forged one fails the HMAC.
 *  - `emailVerified` is passed through honestly. GitHub's /user endpoint will
 *    happily return an unverified address; linking on it would let anyone
 *    inherit an account by signing up with someone else's email.
 */

export type ProviderName = "google" | "github";

export interface Profile {
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  avatarUrl?: string;
}

interface Provider {
  authUrl: string;
  tokenUrl: string;
  scope: string;
  clientId: () => string | undefined;
  clientSecret: () => string | undefined;
  fetchProfile: (accessToken: string) => Promise<Profile>;
}

const PROVIDERS: Record<ProviderName, Provider> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    async fetchProfile(accessToken) {
      const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) throw new Error(`google userinfo failed: ${r.status}`);
      const u = (await r.json()) as {
        sub: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
      };
      if (!u.email) throw new Error("google returned no email");
      return {
        providerUserId: u.sub,
        email: u.email,
        emailVerified: u.email_verified === true,
        name: u.name,
        avatarUrl: u.picture,
      };
    },
  },

  github: {
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    clientId: () => process.env.GITHUB_CLIENT_ID,
    clientSecret: () => process.env.GITHUB_CLIENT_SECRET,
    async fetchProfile(accessToken) {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "skym-service",
      };
      const r = await fetch("https://api.github.com/user", { headers });
      if (!r.ok) throw new Error(`github user failed: ${r.status}`);
      const u = (await r.json()) as { id: number; login: string; name?: string; avatar_url?: string };

      // /user's email may be null (private) or unverified. The emails endpoint
      // is the only place that says which address is both primary and verified.
      const er = await fetch("https://api.github.com/user/emails", { headers });
      let email: string | undefined;
      let verified = false;
      if (er.ok) {
        const emails = (await er.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
        const primary = emails.find((e) => e.primary) ?? emails[0];
        email = primary?.email;
        verified = primary?.verified === true;
      }
      if (!email) throw new Error("github returned no email; grant the user:email scope");

      return {
        providerUserId: String(u.id),
        email,
        emailVerified: verified,
        name: u.name ?? u.login,
        avatarUrl: u.avatar_url,
      };
    },
  },
};

export const providerNames = Object.keys(PROVIDERS) as ProviderName[];

export function isConfigured(name: ProviderName): boolean {
  const p = PROVIDERS[name];
  return Boolean(p.clientId() && p.clientSecret());
}

/** Which providers a deploy can actually offer, for the sign-in page. */
export const configuredProviders = (): ProviderName[] => providerNames.filter(isConfigured);

function stateSecret(): string {
  const s = process.env.STATE_SECRET ?? process.env.GOOGLE_CLIENT_SECRET ?? process.env.GITHUB_CLIENT_SECRET;
  if (!s) throw new Error("STATE_SECRET is not set");
  return s;
}

/**
 * `<nonce>.<returnTo>.<hmac>` — self-verifying, so no server-side storage.
 * returnTo is carried through the round trip and validated on the way back.
 */
export function signState(returnTo = "/"): string {
  const nonce = randomBytes(16).toString("base64url");
  const payload = `${nonce}.${Buffer.from(returnTo).toString("base64url")}`;
  const mac = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifyState(state: string | null): { ok: boolean; returnTo: string } {
  if (!state) return { ok: false, returnTo: "/" };
  const parts = state.split(".");
  if (parts.length !== 3) return { ok: false, returnTo: "/" };
  const [nonce, encoded, mac] = parts as [string, string, string];
  const expected = createHmac("sha256", stateSecret()).update(`${nonce}.${encoded}`).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, returnTo: "/" };

  const returnTo = Buffer.from(encoded, "base64url").toString("utf8");
  // Only same-origin paths: an absolute URL here is an open redirect.
  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  return { ok: true, returnTo: safe };
}

export function authorizeUrl(name: ProviderName, redirectUri: string, state: string): string {
  const p = PROVIDERS[name];
  const url = new URL(p.authUrl);
  url.searchParams.set("client_id", p.clientId()!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", p.scope);
  url.searchParams.set("state", state);
  if (name === "google") {
    // Without this Google omits the refresh token and re-prompt behaviour is
    // inconsistent between first and later logins.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "select_account");
  }
  return url.toString();
}

export async function exchangeCode(name: ProviderName, code: string, redirectUri: string): Promise<string> {
  const p = PROVIDERS[name];
  const r = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: p.clientId()!,
      client_secret: p.clientSecret()!,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!r.ok) throw new Error(`${name} token exchange failed: ${r.status}`);
  const body = (await r.json()) as { access_token?: string; error?: string };
  if (!body.access_token) throw new Error(`${name} token exchange returned no token: ${body.error ?? "unknown"}`);
  return body.access_token;
}

export const fetchProfile = (name: ProviderName, accessToken: string): Promise<Profile> =>
  PROVIDERS[name].fetchProfile(accessToken);
