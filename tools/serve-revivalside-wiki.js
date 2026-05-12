const fs = require("fs");
const http = require("http");
const path = require("path");
const url = require("url");

const ROOT_DIR = path.resolve(__dirname, "..");
const WIKI_DIR = path.join(ROOT_DIR, "wiki");
const EXTRACTED_ASSET_ROOT = path.join(ROOT_DIR, "extracted-assets", "all");
const DEFAULT_PORT = 5174;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const requestedPort = parsePort(process.argv) || parsePort(process.env.REVIVALSIDE_WIKI_PORT) || DEFAULT_PORT;
startServer(requestedPort, 0);

function startServer(port, attempts) {
  const server = http.createServer(handleRequest);
  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE" && attempts < 20) {
      startServer(port + 1, attempts + 1);
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`RevivalSide Wiki running at http://127.0.0.1:${port}/`);
  });
}

function handleRequest(req, res) {
  const parsed = url.parse(req.url || "/");
  const pathname = decodeURIComponent(parsed.pathname || "/");
  if (pathname.startsWith("/asset-png/")) {
    serveFile(path.resolve(EXTRACTED_ASSET_ROOT, pathname.slice("/asset-png/".length)), EXTRACTED_ASSET_ROOT, res);
    return;
  }

  const safePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(WIKI_DIR, safePath);

  serveFile(target, WIKI_DIR, res);
}

function serveFile(target, root, res) {
  if (!target.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(target, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const type = CONTENT_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream";
    const noStore = type.includes("json") || type.includes("html") || type.includes("css") || type.includes("javascript");
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": noStore ? "no-store" : "public, max-age=60",
    });
    fs.createReadStream(target).pipe(res);
  });
}

function parsePort(value) {
  const args = Array.isArray(value) ? value : [value];
  const portFlagIndex = args.indexOf("--port");
  const raw = portFlagIndex >= 0 ? args[portFlagIndex + 1] : args[0];
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
}
