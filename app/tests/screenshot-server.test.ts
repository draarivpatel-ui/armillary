import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createScreenshotServer } from "../scripts/server";

describe("Screenshot dev server security (Finding 11)", () => {
  let server: http.Server;
  let port: number;
  const fixturesDist = path.resolve(__dirname, "fixtures/dist");

  beforeAll(async () => {
    fs.mkdirSync(fixturesDist, { recursive: true });
    fs.writeFileSync(path.join(fixturesDist, "index.html"), "<html><body>App Shell</body></html>");
    fs.writeFileSync(path.join(fixturesDist, "test.css"), "body { color: red; }");

    server = createScreenshotServer(fixturesDist);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { address: string; port: number };
        port = addr.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(fixturesDist, { recursive: true, force: true });
  });

  function rawGet(reqPath: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: reqPath,
          method: "GET",
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode || 0, text: data }));
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("binds strictly to loopback 127.0.0.1 only", () => {
    const addr = server.address() as { address: string; port: number };
    expect(addr.address).toBe("127.0.0.1");
  });

  it("serves valid static files inside dist root", async () => {
    const res = await rawGet("/index.html");
    expect(res.status).toBe(200);
    expect(res.text).toContain("App Shell");
  });

  it("rejects path traversal attempts using ../ with 403 Forbidden", async () => {
    // Raw GET /../package.json attempts to escape distDir
    const res = await rawGet("/../package.json");
    expect(res.status).toBe(403);
    expect(res.text).not.toContain("orrery");
  });

  it("rejects encoded path traversal attempts (e.g. %2e%2e) with 403 or 400", async () => {
    const res = await rawGet("/%2e%2e/Cargo.lock");
    expect([400, 403]).toContain(res.status);
    expect(res.text).not.toContain("version");
  });

  it("never falls back to index.html when path traversal is attempted", async () => {
    const res = await rawGet("/../../../../etc/passwd");
    expect(res.status).toBe(403);
    expect(res.text).not.toContain("App Shell");
  });
});
