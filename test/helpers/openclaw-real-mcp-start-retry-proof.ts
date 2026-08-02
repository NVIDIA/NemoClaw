// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface ProofOptions {
  dist: string;
  nodeExecutable: string;
  patchScript: string;
  timeoutMs: number;
}

interface ProofScenario {
  mode: "recover" | "always-reset" | "unauthorized";
  run1ToolCount: number;
  run2ToolCount: number;
  run1ServerAttempts: number;
  run2ServerAttempts: number;
  run1Diagnostics: string[];
  run2Diagnostics: string[];
}

function requireSuccess(
  result: { status: number | null; stdout?: string | null; stderr?: string | null },
  label: string,
): void {
  if (result.status === 0) return;
  const detail = String(result.stderr || result.stdout || "").trim();
  throw new Error(`${label}${detail ? `: ${detail}` : ""}: expected exit 0, got ${result.status}`);
}

function requireEqual(actual: string, expected: string, label: string): void {
  if (actual === expected) return;
  throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

/**
 * Controlled reporter-workflow proof for NVIDIA/NemoClaw#7958.
 *
 * Drives the real patched `bundle-mcp` session runtime against a controlled
 * Streamable HTTP MCP server whose first POST exchange resets before headers.
 * Proves the tools materialize in the original agent run, that an exhausted
 * retry reports a temporary transport failure, and that a non-retryable 401 is
 * never retried.
 */
export function runRealOpenClawMcpStartRetryProof(options: ProofOptions): void {
  const applied = spawnSync(
    options.nodeExecutable,
    ["--experimental-strip-types", options.patchScript, options.dist],
    { encoding: "utf8", timeout: options.timeoutMs },
  );
  requireSuccess(applied, "apply MCP startup recovery patch");

  const audit = spawnSync(
    options.nodeExecutable,
    ["--experimental-strip-types", options.patchScript, "--audit", options.dist],
    { encoding: "utf8", timeout: options.timeoutMs },
  );
  requireSuccess(audit, "audit MCP startup recovery patch");
  if (!String(audit.stdout ?? "").includes("MCP startup recovery audit ok")) {
    throw new Error("MCP startup recovery audit did not confirm the patched dist");
  }

  const runtimeTargets = fs
    .readdirSync(options.dist)
    .filter((file) => /^agent-bundle-mcp-runtime-.+\.js$/.test(file))
    .filter((file) =>
      fs
        .readFileSync(path.join(options.dist, file), "utf8")
        .includes("/* nemoclaw mcp transient startup recovery (#7958) */"),
    );
  requireEqual(String(runtimeTargets.length), "1", "MCP startup recovery patch target count");

  const syntax = spawnSync(
    options.nodeExecutable,
    ["--check", path.join(options.dist, runtimeTargets[0] as string)],
    { encoding: "utf8", timeout: options.timeoutMs },
  );
  requireSuccess(syntax, "validate patched bundle-mcp runtime syntax");

  // This behavioral proof imports the reviewed bundle-mcp runtime, so install
  // its shrinkwrapped production dependencies in the throwaway extraction.
  // Lifecycle scripts stay disabled, matching the reviewed Docker boundary.
  const packageDir = path.dirname(options.dist);
  const install = spawnSync(
    "npm",
    ["install", "--ignore-scripts", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"],
    { cwd: packageDir, encoding: "utf8", timeout: options.timeoutMs },
  );
  requireSuccess(install, "install reviewed OpenClaw runtime dependencies without scripts");

  const proofFile = path.join(options.dist, ".nemoclaw-mcp-start-retry-proof.mjs");
  fs.writeFileSync(proofFile, MCP_START_RETRY_PROOF_SCRIPT);
  const proof = spawnSync(options.nodeExecutable, [proofFile], {
    cwd: packageDir,
    encoding: "utf8",
    timeout: options.timeoutMs,
  });
  requireSuccess(proof, "run controlled MCP startup recovery proof");

  const marker = String(proof.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith("NEMOCLAW_MCP_START_RETRY_PROOF="));
  if (!marker) throw new Error("controlled MCP startup recovery proof produced no result marker");
  const scenarios = JSON.parse(
    marker.slice("NEMOCLAW_MCP_START_RETRY_PROOF=".length),
  ) as ProofScenario[];

  const byMode = new Map(scenarios.map((scenario) => [scenario.mode, scenario]));

  const recover = byMode.get("recover");
  if (!recover) throw new Error("controlled proof is missing the recover scenario");
  requireEqual(String(recover.run1ToolCount), "1", "recovered tool count in the original run");
  requireEqual(String(recover.run1Diagnostics.length), "0", "recovered run diagnostics");
  requireEqual(String(recover.run2ServerAttempts), "0", "healthy catalog reuse on the next run");

  const exhausted = byMode.get("always-reset");
  if (!exhausted) throw new Error("controlled proof is missing the always-reset scenario");
  requireEqual(String(exhausted.run1ServerAttempts), "2", "one bounded retry per agent run");
  requireEqual(String(exhausted.run2ServerAttempts), "2", "degraded catalog re-probe on next run");
  for (const [label, diagnostics] of [
    ["run 1", exhausted.run1Diagnostics],
    ["run 2", exhausted.run2Diagnostics],
  ] as Array<[string, string[]]>) {
    requireEqual(String(diagnostics.length), "1", `exhausted retry diagnostic count on ${label}`);
    if (!diagnostics[0].includes("temporary MCP transport failure")) {
      throw new Error(`exhausted retry diagnostic on ${label} omits the temporary-transport cause`);
    }
    if (!diagnostics[0].includes("Credentials and configuration were not rejected")) {
      throw new Error(
        `exhausted retry diagnostic on ${label} does not state that credentials and configuration were not rejected`,
      );
    }
  }

  const unauthorized = byMode.get("unauthorized");
  if (!unauthorized) throw new Error("controlled proof is missing the unauthorized scenario");
  requireEqual(String(unauthorized.run1ServerAttempts), "1", "no retry after an authorization 401");
  requireEqual(
    String(unauthorized.run2ServerAttempts),
    "1",
    "one un-retried attempt per run after an authorization 401",
  );
  requireEqual(
    String(unauthorized.run1Diagnostics.length),
    "1",
    "authorization diagnostic count on run 1",
  );
  if (unauthorized.run1Diagnostics[0].includes("temporary MCP transport failure")) {
    throw new Error("authorization failure was reported as a temporary transport failure");
  }
  // OpenClaw surfaces the server's OAuth rejection payload rather than the
  // status line, so the preserved diagnostic reads
  // `Error POSTing to endpoint: {"error":"invalid_token"}`. That `invalid_token`
  // token is also what the patch's blocked-text pattern keys on, so asserting it
  // pins both the preserved attribution and the reason the retry was refused.
  if (!/invalid_token|401|unauthoriz|credential/i.test(unauthorized.run1Diagnostics[0])) {
    throw new Error(
      `authorization diagnostic does not attribute the failure to the credential rejection: ${unauthorized.run1Diagnostics[0]}`,
    );
  }
}

const MCP_START_RETRY_PROOF_SCRIPT = `// Generated by test/helpers/openclaw-real-mcp-start-retry-proof.ts
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const distDir = path.resolve(process.argv[1], "..");
const pick = (pattern) => fs.readdirSync(distDir).find((file) => pattern.test(file));
const runtimeMod = await import(pathToFileURL(path.join(distDir, pick(/^agent-bundle-mcp-runtime-.+\\.js$/))).href);
const materializeMod = await import(pathToFileURL(path.join(distDir, pick(/^agent-bundle-mcp-materialize-.+\\.js$/))).href);
const createSessionMcpRuntime = runtimeMod.n;
const materializeBundleMcpToolsForRun = materializeMod.r;

const TOOLS = [{ name: "search_docs", description: "Search the remote knowledge base.", inputSchema: { type: "object", properties: { query: { type: "string" } } } }];

function startControlledServer(mode) {
  let posts = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    posts += 1;
    const attempt = posts;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (mode === "unauthorized") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      if (mode === "always-reset" || attempt === 1) {
        req.socket.destroy();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (typeof body.id === "undefined") {
        res.writeHead(202).end();
        return;
      }
      const result = body.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "controlled-remote-mcp", version: "1.0.0" } }
        : body.method === "tools/list" ? { tools: TOOLS } : {};
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "proof-7958" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  return { server, posts: () => posts };
}

async function runScenario(mode) {
  const { server, posts } = startControlledServer(mode);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = \`http://127.0.0.1:\${server.address().port}/mcp\`;
  const workspaceDir = fs.mkdtempSync(path.join(distDir, ".mcp-proof-ws-"));
  const runtime = createSessionMcpRuntime({
    sessionId: \`proof-\${mode}\`,
    sessionKey: \`proof-\${mode}\`,
    workspaceDir,
    cfg: { plugins: { enabled: false }, mcp: { servers: { remotedocs: { transport: "streamable-http", url, connectTimeout: 5, requestTimeoutMs: 5000 } } } },
  });

  const agentRun = async () => {
    const before = posts();
    const materialized = await materializeBundleMcpToolsForRun({ runtime, reservedToolNames: new Set() });
    const catalog = runtime.peekCatalog();
    materialized.dispose?.();
    return {
      toolCount: materialized.tools.length,
      attempts: posts() - before,
      diagnostics: (catalog?.diagnostics ?? []).map((entry) => entry.message),
    };
  };

  const run1 = await agentRun();
  const run2 = await agentRun();
  await runtime.dispose?.();
  server.close();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  return {
    mode,
    run1ToolCount: run1.toolCount,
    run2ToolCount: run2.toolCount,
    run1ServerAttempts: run1.attempts,
    run2ServerAttempts: run2.attempts,
    run1Diagnostics: run1.diagnostics,
    run2Diagnostics: run2.diagnostics,
  };
}

const scenarios = [];
for (const mode of ["recover", "always-reset", "unauthorized"]) {
  scenarios.push(await runScenario(mode));
}
console.log(\`NEMOCLAW_MCP_START_RETRY_PROOF=\${JSON.stringify(scenarios)}\`);
process.exit(0);
`;
