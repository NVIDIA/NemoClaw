// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

import { afterEach, describe, expect, it } from "vitest";

import { getOllamaPullTimeoutMs } from "../dist/lib/onboard-ollama-proxy.js";

const ENV = "NEMOCLAW_OLLAMA_PULL_TIMEOUT";
const DEFAULT_MS = 30 * 60 * 1000;

describe("getOllamaPullTimeoutMs", () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it("falls back to the 30-minute default when the env var is unset", () => {
    delete process.env[ENV];
    expect(getOllamaPullTimeoutMs()).toBe(DEFAULT_MS);
  });

  it("falls back to the default when the env var is empty or whitespace", () => {
    process.env[ENV] = "";
    expect(getOllamaPullTimeoutMs()).toBe(DEFAULT_MS);
    process.env[ENV] = "   ";
    expect(getOllamaPullTimeoutMs()).toBe(DEFAULT_MS);
  });

  it("converts a positive integer seconds value to milliseconds", () => {
    process.env[ENV] = "1800";
    expect(getOllamaPullTimeoutMs()).toBe(1_800_000);
  });

  it("converts fractional second inputs to milliseconds", () => {
    process.env[ENV] = "1.5";
    expect(getOllamaPullTimeoutMs()).toBe(1_500);
  });

  it("preserves sub-second precision when passing the HTTP pull timeout to curl", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-pull-timeout-"));
    const scriptPath = path.join(tmpDir, "http-timeout-check.js");
    const proxyPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard-ollama-proxy.js"));
    const localInferencePath = JSON.stringify(path.join(repoRoot, "dist", "lib", "local-inference.js"));
    const script = `
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const childProcess = require("child_process");
const localInference = require(${localInferencePath});

let captured = null;
childProcess.spawn = (cmd, args) => {
  captured = { cmd, args };
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  process.nextTick(() => {
    child.stdout.end('{"status":"success"}\\n', () => {
      setImmediate(() => child.emit("close", 0));
    });
  });
  return child;
};

localInference.setResolvedOllamaHost(localInference.OLLAMA_HOST_DOCKER_INTERNAL);
process.env.${ENV} = "0.5";

const { pullOllamaModel } = require(${proxyPath});

const originalLog = console.log;
console.log = () => {};
pullOllamaModel("qwen2.5:7b")
  .then((ok) => {
    console.log = originalLog;
    originalLog(JSON.stringify({ ok, captured }));
  })
  .catch((error) => {
    console.log = originalLog;
    console.error(error);
    process.exit(1);
  });
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
    });

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.captured.cmd).toBe("curl");
    const maxTimeIndex = payload.captured.args.indexOf("--max-time");
    expect(maxTimeIndex).toBeGreaterThanOrEqual(0);
    expect(payload.captured.args[maxTimeIndex + 1]).toBe("0.5");
  });

  it("falls back to the default for non-numeric values", () => {
    process.env[ENV] = "thirty-minutes";
    expect(getOllamaPullTimeoutMs()).toBe(DEFAULT_MS);
  });

  it("falls back to the default for zero or negative values", () => {
    process.env[ENV] = "0";
    expect(getOllamaPullTimeoutMs()).toBe(DEFAULT_MS);
    process.env[ENV] = "-60";
    expect(getOllamaPullTimeoutMs()).toBe(DEFAULT_MS);
  });
});
