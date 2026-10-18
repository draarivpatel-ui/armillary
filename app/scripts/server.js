import http from "node:http";
import fs from "node:fs";
import path from "node:path";

export const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/**
 * Creates a hardened static file server strictly contained to the canonical dist root.
 * Enforces canonical containment to prevent directory traversal attacks (Finding 11).
 * Must be bound to 127.0.0.1 only.
 */
export function createScreenshotServer(distDir) {
  let canonicalDist;
  try {
    canonicalDist = fs.realpathSync(path.resolve(distDir));
  } catch {
    canonicalDist = path.resolve(distDir);
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      return res.end("Method Not Allowed");
    }

    let rawPath = req.url.split("?")[0];
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Bad Request");
    }

    // Reject null byte injection
    if (decodedPath.includes("\0")) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Bad Request");
    }

    // Default root
    if (decodedPath === "/" || decodedPath === "") {
      decodedPath = "/index.html";
    }

    // Strip leading slashes to resolve safely relative to canonicalDist
    const safeSuffix = decodedPath.replace(/^[/\\]+/, "");
    const candidatePath = path.resolve(canonicalDist, safeSuffix);

    // Canonical containment check: relative path must NOT escape canonicalDist
    const relative = path.relative(canonicalDist, candidatePath);
    const isContained = !relative.startsWith("..") && !path.isAbsolute(relative);

    if (!isContained) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Forbidden: Path traversal blocked");
    }

    // Symlink resolution check
    let targetPath = candidatePath;
    try {
      if (fs.existsSync(candidatePath)) {
        const real = fs.realpathSync(candidatePath);
        const realRel = path.relative(canonicalDist, real);
        if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          return res.end("Forbidden: Path traversal blocked");
        }
        targetPath = real;
      }
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not Found");
    }

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
      const ext = path.extname(targetPath);
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
      if (req.method === "HEAD") {
        return res.end();
      }
      fs.createReadStream(targetPath).pipe(res);
    } else {
      // SPA fallback to index.html ONLY IF no traversal was attempted
      const indexHtml = path.join(canonicalDist, "index.html");
      if (fs.existsSync(indexHtml) && fs.statSync(indexHtml).isFile()) {
        res.writeHead(200, { "Content-Type": "text/html" });
        if (req.method === "HEAD") {
          return res.end();
        }
        fs.createReadStream(indexHtml).pipe(res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    }
  });

  return server;
}
