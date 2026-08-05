/** Shared chrome for the site's pages: session lookup and the nav bar. */

export const $ = (id) => document.getElementById(id);

export const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const me = () =>
  fetch("/api/me")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

export const providers = () =>
  fetch("/api/providers")
    .then((r) => r.json())
    .then((b) => b.providers ?? [])
    .catch(() => []);

export const PROVIDER_LABEL = { google: "Continue with Google", github: "Continue with GitHub" };

/** Relative time, so a dashboard reads at a glance rather than in timestamps. */
export function ago(iso) {
  if (!iso) return "";
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(secs)) return "";
  if (secs < 60) return "just now";
  const units = [
    ["m", 60],
    ["h", 3600],
    ["d", 86400],
    ["w", 604800],
  ];
  let out = "just now";
  for (const [suffix, size] of units) {
    if (secs >= size) out = `${Math.floor(secs / size)}${suffix} ago`;
  }
  return out;
}

/** Byte counts as a person reads them, not as the database stores them. */
export function bytes(n) {
  const size = Number(n) || 0;
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = size / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const initials = (user) => (user.name || user.email || "?").trim().charAt(0).toUpperCase();

/**
 * Renders the nav into #nav. The signed-out bar advertises the product; the
 * signed-in one navigates it, so the same markup serves both pages.
 */
export function renderNav(user, current) {
  const el = $("nav");
  if (!el) return;

  const link = (href, text) =>
    `<a href="${href}"${current === href ? ' aria-current="page"' : ""}>${text}</a>`;

  const left = user
    ? `<nav class="nav-links">${link("/dashboard", "My Charts")}${link("/settings", "Settings")}</nav>`
    : "";

  const right = user
    ? `<a class="avatar" href="/settings" title="${escapeHtml(user.email)}">` +
      (user.avatar_url
        ? `<img src="${escapeHtml(user.avatar_url)}" alt="" referrerpolicy="no-referrer" />`
        : escapeHtml(initials(user))) +
      `</a>` +
      `<form method="POST" action="/auth/logout"><button class="btn" type="submit">Sign out</button></form>`
    : `<a class="btn primary" href="/dashboard">Sign in</a>`;

  el.innerHTML =
    `<div class="wrap nav-inner">` +
    `<a class="brand" href="/"><span aria-hidden="true">🗺️</span> skym</a>` +
    left +
    `<div class="nav-right">${right}</div>` +
    `</div>`;
}

export function renderFooter() {
  const el = $("foot");
  if (!el) return;
  el.innerHTML =
    `<div class="wrap foot-inner">` +
    `<span>skym — a live flowchart of what your agent is doing.</span>` +
    `<span class="spacer"></span>` +
    `<a href="https://github.com/GQChem/skym">GitHub</a>` +
    `</div>`;
}

/** Sign-in buttons, or an honest message when the deploy has no provider set. */
export async function renderSignin(target) {
  const list = await providers();
  if (!list.length) {
    target.innerHTML = `<p class="msg bad">No sign-in provider is configured on this deploy.</p>`;
    return;
  }
  target.innerHTML = list
    .map(
      (p) =>
        `<a class="btn primary block" href="/auth/${encodeURIComponent(p)}?return_to=${encodeURIComponent(
          location.pathname,
        )}">${escapeHtml(PROVIDER_LABEL[p] ?? p)}</a>`,
    )
    .join("");
}
