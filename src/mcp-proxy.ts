// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stdio-to-HTTP MCP proxy.
 *
 * Spawns a stdio-based MCP server as a child process and exposes it over HTTP
 * so it can be forwarded into a NemoClaw sandbox. Compiled to dist/mcp-proxy.js
 * and spawned by the MCP bridge (src/lib/actions/sandbox/mcp-bridge.ts) — it is
 * an executable entrypoint, never imported.
 *
 * Usage:
 *   node dist/mcp-proxy.js --exe npx --arg @modelcontextprotocol/server-github \
 *     --env GITHUB_TOKEN --port 3101
 *
 * The proxy binds to 127.0.0.1 only. API keys are inherited from the host
 * environment via --env flags and never logged or written to disk.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";

// ── Parse args ──────────────────────────────────────────────────

interface ProxyConfig {
  exe: string | null;
  cmdArgs: string[];
  env: string[];
  port: number;
  tokenEnv: string | null;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function parseArgs(argv: string[]): ProxyConfig {
  const args: ProxyConfig = { exe: null, cmdArgs: [], env: [], port: 3101, tokenEnv: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--exe":
        args.exe = argv[++i] ?? null;
        break;
      case "--arg":
        args.cmdArgs.push(argv[++i] ?? "");
        break;
      case "--env":
        args.env.push(argv[++i] ?? "");
        break;
      case "--port":
        args.port = Number.parseInt(argv[++i] ?? "", 10);
        break;
      case "--token-env":
        // Name of the env var holding the bearer token. Passed by name so the
        // value never appears in `ps` output.
        args.tokenEnv = argv[++i] ?? null;
        break;
    }
  }
  return args;
}

const config = parseArgs(process.argv.slice(2));

if (!config.exe) {
  console.error(
    "Usage: mcp-proxy.js --exe <binary> [--arg <arg> ...] [--env VAR ...] [--port PORT]",
  );
  process.exit(1);
}

// Validate that named env vars are set
for (const name of config.env) {
  if (!process.env[name]) {
    console.error(`Environment variable ${name} is not set.`);
    process.exit(1);
  }
}

// Resolve the bearer token (if requested) and forget the env var name so the
// token never reaches the upstream MCP child process.
let bearerToken: string | null = null;
if (config.tokenEnv) {
  bearerToken = process.env[config.tokenEnv] ?? null;
  if (!bearerToken) {
    console.error(`Bearer token env var ${config.tokenEnv} is not set.`);
    process.exit(1);
  }
  delete process.env[config.tokenEnv];
}

// Secret values to scrub from captured child stderr. The proxy logs child
// stderr for debugging; an MCP server that prints its own environment (or a
// config dump) could otherwise leak the host API keys passed via -e into the
// per-bridge log file. Build the list once at startup. Includes the bearer
// token defensively even though it is never handed to the child.
const secretValues: string[] = [...config.env.map((name) => process.env[name]), bearerToken].filter(
  (v): v is string => typeof v === "string" && v.length > 0,
);

function redactSecrets(text: string): string {
  let out = text;
  for (const secret of secretValues) {
    out = out.split(secret).join("***REDACTED***");
  }
  return out;
}

// ── MCP stdio child process ─────────────────────────────────────

let child: ChildProcessWithoutNullStreams | null = null;
let childReady = false;
let pendingRequests: JsonRpcMessage[] = [];

function startChild(): void {
  const { exe, cmdArgs } = config;
  if (!exe) return;

  // The exe is passed via argv to spawn() with shell:false (default), so shell
  // metacharacters in the binary name are not a security concern — they'd
  // simply ENOENT. We do not blacklist them.

  // Build a minimal env with only the named variables plus essentials
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SHELL: process.env.SHELL,
    TERM: process.env.TERM || "xterm-256color",
    NODE_ENV: process.env.NODE_ENV || "production",
  };
  for (const name of config.env) {
    childEnv[name] = process.env[name];
  }

  child = spawn(exe, cmdArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });

  let buffer = "";

  child.stdout.on("data", (data: Buffer) => {
    buffer += data.toString();
    // MCP stdio uses newline-delimited JSON-RPC
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        handleChildMessage(msg);
      } catch {
        // not JSON, ignore
      }
    }
  });

  // Redact secrets line-by-line. Redacting each raw data chunk independently
  // would miss a secret split across two chunks, leaking it to the log; buffer
  // until a newline so redaction always sees whole lines.
  let stderrBuffer = "";
  child.stderr.on("data", (data: Buffer) => {
    stderrBuffer += data.toString();
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      process.stderr.write(`[mcp-proxy:child] ${redactSecrets(line)}\n`);
    }
  });

  child.on("close", (code: number | null) => {
    // Flush any trailing partial line (still redacted) before exiting.
    if (stderrBuffer) {
      process.stderr.write(`[mcp-proxy:child] ${redactSecrets(stderrBuffer)}\n`);
      stderrBuffer = "";
    }
    console.error(`[mcp-proxy] child exited with code ${code}`);
    process.exit(code || 1);
  });

  child.on("error", (err: Error) => {
    console.error(`[mcp-proxy] child spawn error: ${err.message}`);
    process.exit(1);
  });

  childReady = true;

  // Flush pending requests
  for (const req of pendingRequests) {
    sendToChild(req);
  }
  pendingRequests = [];
}

// ── JSON-RPC message routing ────────────────────────────────────

const responseCallbacks = new Map<number, (msg: JsonRpcMessage) => void>();
let nextId = 1;

function sendToChild(msg: JsonRpcMessage): void {
  if (!child || !child.stdin.writable) return;
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

function handleChildMessage(msg: JsonRpcMessage): void {
  // Check if this is a response to a pending request
  if (typeof msg.id === "number" && responseCallbacks.has(msg.id)) {
    const callback = responseCallbacks.get(msg.id);
    responseCallbacks.delete(msg.id);
    callback?.(msg);
    return;
  }
  // Notifications or server-initiated messages are logged
  if (msg.method) {
    console.log(`[mcp-proxy:notify] ${msg.method}`);
  }
}

const REQUEST_TIMEOUT_MS = 120000; // 2 minutes
const MAX_INFLIGHT = 100;

function callChild(method: string | undefined, params: unknown): Promise<JsonRpcMessage> {
  if (responseCallbacks.size >= MAX_INFLIGHT) {
    return Promise.reject(new Error("Too many in-flight requests"));
  }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      responseCallbacks.delete(id);
      reject(new Error("MCP request timed out"));
    }, REQUEST_TIMEOUT_MS);
    responseCallbacks.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    if (childReady) {
      sendToChild(msg);
    } else {
      pendingRequests.push(msg);
    }
  });
}

// ── HTTP server ─────────────────────────────────────────────────

function authorize(req: http.IncomingMessage): boolean {
  if (!bearerToken) return true;
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  // Compare fixed-length SHA-256 digests rather than the raw strings. This
  // sidesteps two problems at once: timingSafeEqual throws on unequal-length
  // inputs (a crafted header could crash the request handler — DoS), and a raw
  // length pre-check would itself be a timing oracle distinguishing wrong-length
  // from same-length-wrong tokens. Digests are always 32 bytes, so the compare
  // is constant-time regardless of the supplied header.
  const headerDigest = crypto.createHash("sha256").update(header).digest();
  const expectedDigest = crypto.createHash("sha256").update(`Bearer ${bearerToken}`).digest();
  return crypto.timingSafeEqual(headerDigest, expectedDigest);
}

const server = http.createServer(async (req, res) => {
  // No CORS headers — the sandbox accesses this via port forward, not a browser.
  // Omitting CORS prevents drive-by browser requests to localhost.

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  if (!authorize(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Unauthorized" },
      }),
    );
    return;
  }

  const MAX_BODY = 10 * 1024 * 1024; // 10 MB
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Request too large" },
        }),
      );
      return;
    }
  }

  let request: JsonRpcMessage;
  try {
    request = JSON.parse(body) as JsonRpcMessage;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
      }),
    );
    return;
  }

  try {
    const response = await callChild(request.method, request.params);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: (err as Error).message },
      }),
    );
  }
});

// ── Start ───────────────────────────────────────────────────────

// Fail loud and fast if the port can't be bound (e.g. EADDRINUSE because a
// non-MCP process grabbed it after the registry reserved it). Without this
// the 'error' event is unhandled and the process crashes with a stack trace;
// the parent waits for a readiness probe and rolls back when it never binds.
server.on("error", (err: Error) => {
  console.error(`[mcp-proxy] failed to listen on 127.0.0.1:${config.port}: ${err.message}`);
  process.exit(1);
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`[mcp-proxy] listening on 127.0.0.1:${config.port}`);
  console.log(`[mcp-proxy] exe: ${config.exe} args: ${config.cmdArgs.join(" ")}`);
  console.log(`[mcp-proxy] env: ${config.env.join(", ") || "(none)"}`);
  console.log(`[mcp-proxy] auth: ${bearerToken ? "bearer-token" : "none"}`);
  startChild();
});

// Graceful shutdown
process.on("SIGTERM", () => {
  if (child) child.kill();
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  if (child) child.kill();
  server.close();
  process.exit(0);
});
