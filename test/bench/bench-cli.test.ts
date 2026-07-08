// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const RUNNER = path.join(REPO_ROOT, "scripts", "bench", "run.ts");
const VALID_COMPLETION = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "PONG" } }],
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cleanBenchEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY",
    "NVIDIA_INFERENCE_API_KEY",
    "OPENAI_BASE_URL",
    "NEMOCLAW_BENCH_BASE_URL",
    "OPENAI_MODEL",
    "NEMOCLAW_BENCH_MODEL",
  ]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

async function runBench(args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  const child = spawn(process.execPath, ["--import", "tsx", RUNNER, ...args], {
    cwd: REPO_ROOT,
    env: cleanBenchEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
}

async function startInferenceServer(
  body: string,
  status = 200,
): Promise<{
  server: http.Server;
  baseUrl: string;
  requests: string[];
}> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    request.resume();
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "test server did not bind TCP");
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("benchmark CLI", () => {
  it("writes JSON and Markdown from a valid completion without leaking target secrets", async () => {
    const fixture = await startInferenceServer(VALID_COMPLETION);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bench-cli-"));
    const jsonPath = path.join(tempDir, "bench.json");
    const reportPath = path.join(tempDir, "bench.md");
    const apiKey = "custom-key-that-must-not-leak";
    const querySecret = "clear-query-secret";
    try {
      const result = await runBench(
        [
          "--base-url",
          `${fixture.baseUrl}/v1?tenant=${querySecret}#ignored`,
          "--model",
          "test-model",
          "--samples",
          "1",
          "--warmup",
          "0",
          "--json",
          jsonPath,
          "--report",
          reportPath,
        ],
        { OPENAI_API_KEY: apiKey },
      );
      const json = fs.readFileSync(jsonPath, "utf8");
      const markdown = fs.readFileSync(reportPath, "utf8");
      const report = JSON.parse(json) as {
        schema_version: string;
        metrics: Array<{ id: string; status: string }>;
      };
      expect(result.code).toBe(0);
      expect(fixture.requests).toEqual([`/v1/chat/completions?tenant=${querySecret}`]);
      expect(report.schema_version).toBe("nemoclaw.bench.v1");
      expect(report.metrics[0]).toMatchObject({ id: "inference-round-trip", status: "ok" });
      expect(`${json}\n${markdown}\n${result.stdout}`).not.toContain(apiKey);
      expect(`${json}\n${markdown}\n${result.stdout}`).not.toContain(querySecret);
    } finally {
      await closeServer(fixture.server);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails when an HTTP 2xx response is not an OpenAI chat completion", async () => {
    const fixture = await startInferenceServer("{}");
    try {
      const result = await runBench(
        [
          "--base-url",
          `${fixture.baseUrl}/v1`,
          "--model",
          "test-model",
          "--samples",
          "1",
          "--warmup",
          "0",
        ],
        { OPENAI_API_KEY: "test-key" },
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("not an OpenAI-compatible chat completion");
    } finally {
      await closeServer(fixture.server);
    }
  });

  it("fails clearly when required inference configuration is missing", async () => {
    const result = await runBench([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Cannot run the inference benchmark, missing:");
    expect(result.stderr).toContain("NEMOCLAW_BENCH_BASE_URL");
    expect(result.stderr).toContain("NEMOCLAW_BENCH_MODEL");
  });

  it("rejects an unrelated API key environment before sending a request", async () => {
    const fixture = await startInferenceServer(VALID_COMPLETION);
    const unrelatedSecret = "github-token-that-must-not-leak";
    try {
      const result = await runBench(
        [
          "--base-url",
          `${fixture.baseUrl}/v1`,
          "--model",
          "test-model",
          "--api-key-env",
          "GITHUB_TOKEN",
          "--samples",
          "1",
          "--warmup",
          "0",
        ],
        { GITHUB_TOKEN: unrelatedSecret },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "--api-key-env must be OPENAI_API_KEY or NVIDIA_INFERENCE_API_KEY",
      );
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(unrelatedSecret);
      expect(fixture.requests).toEqual([]);
    } finally {
      await closeServer(fixture.server);
    }
  });
});
