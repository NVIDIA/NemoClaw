// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// End-to-end test for the FORWARD-mode rewrite in
// nemoclaw-blueprint/scripts/http-proxy-fix.js.
//
// Spins up a local HTTPS mock server on 127.0.0.1 that pretends to be a
// custom OpenAI-compatible upstream (deepinfra / OpenRouter / vLLM behind
// an OpenShell-routed inference.local). Constructs a FORWARD-mode
// http.request the way axios + HTTPS_PROXY would produce, including the
// forward-proxy http.Agent, proxy basic-auth, and proxy-pointing Host
// header — i.e. exactly the request shape that hit the deepinfra users
// on NemoClaw 0.0.24. Asserts the wrapper's rewrite produces a request
// that actually completes against the upstream.
//
// Self-signed cert is generated in-memory via openssl at test setup.
// Skipped if openssl is not on PATH.

import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FIX_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "nemoclaw-blueprint",
  "scripts",
  "http-proxy-fix.js",
);
const PROXY_HOST = "10.200.0.1";

// Cert setup at module load (not inside beforeAll) so the result is
// visible to `it.skipIf` at definition time.
function trySetupCert(): { ok: true; key: Buffer; cert: Buffer; dir: string } | { ok: false; reason: string } {
  try {
    execSync("openssl version", { stdio: "pipe" });
  } catch (err) {
    return { ok: false, reason: `openssl missing: ${(err as Error).message}` };
  }
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-proxy-fix-e2e-"));
    // 7-day expiry. Cert is generated at module load (once per test run);
    // 1-day was tight enough that long `vitest --watch` sessions could
    // outrun it. Still ephemeral — `afterAll` rms the dir.
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${dir}/key.pem" -out "${dir}/cert.pem" ` +
        `-days 7 -nodes -subj "/CN=localhost" ` +
        `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
      { stdio: "pipe" },
    );
    return {
      ok: true,
      dir,
      key: fs.readFileSync(path.join(dir, "key.pem")),
      cert: fs.readFileSync(path.join(dir, "cert.pem")),
    };
  } catch (err) {
    return { ok: false, reason: `cert generation failed: ${(err as Error).message}` };
  }
}

const certSetup = trySetupCert();
const opensslAvailable = certSetup.ok;
if (!certSetup.ok) {
  if (process.env.CI === "true") {
    // CI runners (ubuntu-latest, macos-latest) ship openssl. A skip here
    // would be a silent green; fail loud instead so missing infra is
    // visible.
    throw new Error(
      `[http-proxy-fix-e2e] CI=true but openssl unavailable: ${certSetup.reason}. ` +
        `This test must not silently skip in CI — install openssl on the runner.`,
    );
  }
  // eslint-disable-next-line no-console
  console.warn(`[http-proxy-fix-e2e] skipping locally: ${certSetup.reason}`);
}
const key = certSetup.ok ? certSetup.key : Buffer.alloc(0);
const cert = certSetup.ok ? certSetup.cert : Buffer.alloc(0);
const certDir = certSetup.ok ? certSetup.dir : "";

afterAll(() => {
  if (certDir) {
    fs.rmSync(certDir, { recursive: true, force: true });
  }
});

type CapturedRequest = {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

function loadWrapper() {
  delete require.cache[FIX_PATH];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(FIX_PATH);
}

function startMock(): Promise<{ port: number; close: () => Promise<void>; received: CapturedRequest[] }> {
  return new Promise((resolve, reject) => {
    const received: CapturedRequest[] = [];
    const server = https.createServer({ key, cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            choices: [{ index: 0, message: { role: "assistant", content: "PONG" } }],
          }),
        );
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("mock server address unavailable"));
        return;
      }
      resolve({
        port: addr.port,
        received,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

type ResponseSnapshot = {
  status?: number;
  body: string;
};

function sendForwardModeRequest(opts: {
  port: number;
  body: string;
  authorizationHeader: string;
}): Promise<ResponseSnapshot> {
  return new Promise((resolve, reject) => {
    // Mimic exactly what axios + HTTPS_PROXY produces: an http.request to
    // the proxy with a full https:// URL in `path`, an http.Agent set up
    // for the proxy hop, basic-auth meant for the proxy hop, and a Host
    // header pointing at the proxy.
    const proxyAgent = new http.Agent({ keepAlive: false });
    const req = http.request(
      {
        hostname: PROXY_HOST,
        port: 3128,
        path: `https://localhost:${opts.port}/v1/openai/chat/completions`,
        method: "POST",
        agent: proxyAgent,
        auth: "proxyuser:proxypass",
        headers: {
          Host: `${PROXY_HOST}:3128`,
          "Proxy-Authorization": "Basic dXNlcjpwYXNz",
          "Proxy-Connection": "keep-alive",
          Authorization: opts.authorizationHeader,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(opts.body)),
        },
        // Self-signed cert — mock is local. Only honored if the wrapper
        // forwards this option through to https.request.
        rejectUnauthorized: false,
      } as http.RequestOptions & { rejectUnauthorized?: boolean },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf-8") }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("request timeout")));
    req.write(opts.body);
    req.end();
  });
}

describe("http-proxy-fix end-to-end against a local OpenAI-compatible mock", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  // The wrapper monkey-patches `http.request` at module load. Save the
  // original here so we can restore it in afterEach — leaving the patched
  // function in place would chain wrappers across this file's tests and
  // (because vitest `cli` runs many test files in one worker) into other
  // suites in the same process.
  let origHttpRequest: typeof http.request;

  beforeEach(async () => {
    if (!opensslAvailable) return;
    mock = await startMock();
    // Use vi.stubEnv consistently with the rewrite suite. Raw process.env
    // mutation here would skip the unstub-on-fail behavior `vi` provides
    // and could leak `NODE_USE_ENV_PROXY=1` into adjacent test files if
    // an assertion threw before afterEach.
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    vi.stubEnv("HTTPS_PROXY", `http://${PROXY_HOST}:3128`);
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("http_proxy", "");
    origHttpRequest = http.request;
    loadWrapper();
  });

  afterEach(async () => {
    if (!opensslAvailable) return;
    http.request = origHttpRequest;
    await mock.close();
    vi.unstubAllEnvs();
  });

  it.skipIf(!opensslAvailable)(
    "completes a chat-completions POST against a custom upstream through the FORWARD→CONNECT-equivalent rewrite",
    async () => {
      const requestBody = JSON.stringify({
        model: "deepseek-ai/DeepSeek-V4-Flash",
        messages: [{ role: "user", content: "What is 6 multiplied by 7?" }],
      });

      const response = await sendForwardModeRequest({
        port: mock.port,
        body: requestBody,
        authorizationHeader: "Bearer real-deepinfra-token",
      });

      // Positive: the request actually reached the upstream and we got
      // the mock's reply. Without the fix, the forward-proxy http.Agent
      // rides along into https.request and the TLS handshake fails — no
      // response, request errors out.
      expect(response.status).toBe(200);
      const parsed = JSON.parse(response.body);
      expect(parsed?.choices?.[0]?.message?.content).toBe("PONG");

      // Server-side proof of the strips:
      expect(mock.received).toHaveLength(1);
      const captured = mock.received[0]!;
      expect(captured.method).toBe("POST");
      expect(captured.url).toBe("/v1/openai/chat/completions");
      // Caller-intent auth survived the rewrite.
      expect(captured.headers.authorization).toBe("Bearer real-deepinfra-token");
      // Host points at the actual target now, not the proxy.
      expect(captured.headers.host).toBe(`localhost:${mock.port}`);
      // Proxy-hop headers did not leak through to the upstream.
      expect(captured.headers["proxy-authorization"]).toBeUndefined();
      expect(captured.headers["proxy-connection"]).toBeUndefined();
      // Body survived the rewrite intact.
      expect(captured.body).toBe(requestBody);
    },
  );
});
