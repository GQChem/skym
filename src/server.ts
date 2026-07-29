import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toMermaid, type Theme } from "./mermaid.js";
import type { GraphStore } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function payload(store: GraphStore, theme: Theme): string {
  const graph = store.get();
  return JSON.stringify({ graph, mermaid: toMermaid(graph, theme) });
}

function themeOf(url: URL): Theme {
  return url.searchParams.get("theme") === "dark" ? "dark" : "light";
}

export interface Viewer {
  url: string;
  port: number;
  close: () => void;
}

export async function startViewer(
  store: GraphStore,
  preferredPort: number,
  projectDir: string,
): Promise<Viewer> {
  const clients = new Map<http.ServerResponse, Theme>();
  let port = preferredPort;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(`data: ${payload(store, themeOf(url))}\n\n`);
      clients.set(res, themeOf(url));
      // Proxies and browsers drop idle SSE streams; this keeps it warm.
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (pathname === "/graph") {
      const want = url.searchParams.get("chart");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      if (want && want !== store.chartId) {
        // Another chat's chart: read-only snapshot, no live stream.
        const other = store.readChart(want);
        res.end(
          other
            ? JSON.stringify({ graph: other, mermaid: toMermaid(other, themeOf(url)), readOnly: true })
            : JSON.stringify({ error: "no such chart" }),
        );
        return;
      }
      res.end(payload(store, themeOf(url)));
      return;
    }

    if (pathname === "/charts") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(store.listCharts()));
      return;
    }

    // Lets a tab say which project it belongs to when several are open.
    if (pathname === "/whoami") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          project: path.basename(projectDir),
          projectDir,
          root: store.root,
          chartId: store.chartId,
          port,
        }),
      );
      return;
    }

    if (pathname.startsWith("/assets/")) {
      const name = path.basename(pathname);
      const chart = url.searchParams.get("chart");
      const dir =
        chart && chart !== store.chartId
          ? path.join(store.root, "charts", path.basename(chart), "assets")
          : store.assetsDir;
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.join(publicDir, rel);
    // Contain path traversal to the public dir.
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  });

  port = await new Promise<number>((resolve, reject) => {
    const attempt = (p: number, remaining: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && remaining > 0) {
          attempt(p + 1, remaining - 1);
        } else {
          reject(err);
        }
      });
      server.listen(p, "127.0.0.1", () => resolve(p));
    };
    attempt(preferredPort, 20);
  });

  store.subscribe(() => {
    const cache = new Map<Theme, string>();
    for (const [c, t] of clients) {
      if (!cache.has(t)) cache.set(t, `data: ${payload(store, t)}\n\n`);
      c.write(cache.get(t)!);
    }
  });

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () => {
      for (const c of clients.keys()) c.end();
      server.close();
    },
  };
}
