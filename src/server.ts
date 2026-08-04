import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clientConfig, loadConfig } from "./config.js";
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

/** The viewer lays out and paints client-side, so this ships the graph only. */
function payload(store: GraphStore): string {
  return JSON.stringify({ graph: store.get(), readOnly: false });
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
  const clients = new Set<http.ServerResponse>();
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
      res.write(`data: ${payload(store)}\n\n`);
      clients.add(res);
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
      const json = { "Content-Type": "application/json; charset=utf-8" };
      if (want && want !== store.chartId) {
        // Another chat's chart: read-only snapshot, no live stream.
        const other = store.readChart(want);
        if (!other) {
          res.writeHead(404, json);
          res.end(JSON.stringify({ error: "no such chart" }));
          return;
        }
        res.writeHead(200, json);
        res.end(JSON.stringify({ graph: other, readOnly: true }));
        return;
      }
      res.writeHead(200, json);
      res.end(payload(store));
      return;
    }

    // Card appearance is configurable per user and per project.
    if (pathname === "/config") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      // Resolved server-side so the viewer never re-implements the merge order.
      res.end(JSON.stringify(clientConfig(loadConfig(projectDir))));
      return;
    }

    // An earlier build served a static /chart page. Redirect rather than 404:
    // the URL is in old links and tool output, and "/" is what it wanted.
    if (pathname === "/chart") {
      const chart = url.searchParams.get("chart");
      res.writeHead(302, { Location: chart ? `/?chart=${encodeURIComponent(chart)}` : "/" }).end();
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
    const frame = `data: ${payload(store)}\n\n`;
    for (const c of clients) c.write(frame);
  });

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () => {
      for (const c of clients) c.end();
      server.close();
    },
  };
}
