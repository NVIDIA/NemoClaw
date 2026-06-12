// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SANITIZER = path.join(
  process.cwd(),
  ".github/actions/run-e2e-script/sanitize-trace-artifacts.py",
);

function makeTrace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resource_spans: [
      {
        scope_spans: [
          {
            spans: [
              { name: "nemoclaw.onboard", duration_ms: 10, attributes: { token: "nvapi-secret" } },
              {
                name: "nemoclaw.onboard.phase.preflight",
                duration_ms: 1234.5678,
                attributes: { prompt: "do not publish" },
                events: [{ name: "env", attributes: { GITHUB_TOKEN: "ghp_secret" } }],
              },
              {
                name: "nemoclaw.inference.curl_probe",
                duration_ms: 999,
                attributes: { authorization: "Bearer secret" },
              },
            ],
          },
        ],
      },
    ],
    summary: {
      trace_id: "0123456789abcdef0123456789abcdef",
      total_duration_ms: 4567.8912,
      output_path: "/tmp/nemoclaw-traces/raw.json",
      slowest_spans: [
        { name: "nemoclaw.onboard.phase.preflight", duration_ms: 1234.5678, status: "OK" },
        { name: "nemoclaw.inference.curl_probe", duration_ms: 999, status: "ERROR" },
      ],
    },
    ...overrides,
  };
}

function runSanitizer(source: string, output: string): void {
  execFileSync("python3", [SANITIZER, source, output], { encoding: "utf8" });
}

function runSanitizerRaw(source: string, output: string): { status: number; stderr: string } {
  try {
    execFileSync("python3", [SANITIZER, source, output], { encoding: "utf8", stdio: "pipe" });
    return { status: 0, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer | string };
    return {
      status: failure.status ?? 1,
      stderr: Buffer.isBuffer(failure.stderr)
        ? failure.stderr.toString("utf8")
        : String(failure.stderr ?? ""),
    };
  }
}

describe("run-e2e-script trace artifact sanitizer", () => {
  it("writes only trusted timing fields and ignores target-controlled arbitrary files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-trace-sanitize-"));
    const source = path.join(tmp, "raw");
    const output = path.join(tmp, "summary");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "trace.json"), JSON.stringify(makeTrace()), "utf8");
    fs.writeFileSync(
      path.join(source, "env-dump.txt"),
      "NVIDIA_API_KEY=nvapi-super-secret\nGITHUB_TOKEN=ghp_super_secret\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(source, "malicious.json"),
      JSON.stringify({ summary: { total_duration_ms: 1 }, NVIDIA_API_KEY: "nvapi-super-secret" }),
      "utf8",
    );

    runSanitizer(source, output);

    const files = fs.readdirSync(output);
    expect(files).toEqual(["cloud-onboard-trace-timing-summary.json"]);
    const text = fs.readFileSync(path.join(output, files[0]), "utf8");
    const summary = JSON.parse(text) as Record<string, unknown>;

    expect(summary).toEqual({
      schema_version: "nemoclaw.trace_timing.v1",
      trace_id: "0123456789abcdef0123456789abcdef",
      total_duration_ms: 4567.891,
      phases: {
        "nemoclaw.onboard.phase.preflight": 1234.568,
      },
      slowest_spans: [
        { name: "nemoclaw.onboard.phase.preflight", duration_ms: 1234.568, status: "OK" },
      ],
    });
    expect(text).not.toContain("NVIDIA_API_KEY");
    expect(text).not.toContain("GITHUB_TOKEN");
    expect(text).not.toContain("nvapi");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("prompt");
    expect(text).not.toContain("authorization");
    expect(text).not.toContain("output_path");
    expect(text).not.toContain("curl_probe");
  });

  it("emits no artifact when raw traces are malformed or schema-invalid", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-trace-sanitize-invalid-"));
    const source = path.join(tmp, "raw");
    const output = path.join(tmp, "summary");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "bad.json"), "{not-json", "utf8");
    fs.writeFileSync(
      path.join(source, "not-onboard.json"),
      JSON.stringify({ summary: { total_duration_ms: 10 }, resource_spans: [] }),
      "utf8",
    );

    runSanitizer(source, output);

    expect(fs.existsSync(output)).toBe(true);
    expect(fs.readdirSync(output)).toEqual([]);
  });

  it("replaces a target-created output symlink with a trusted directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-trace-sanitize-symlink-"));
    const source = path.join(tmp, "raw");
    const output = path.join(tmp, "summary");
    const targetControlled = path.join(tmp, "target-controlled");
    fs.mkdirSync(source);
    fs.mkdirSync(targetControlled);
    fs.writeFileSync(path.join(source, "trace.json"), JSON.stringify(makeTrace()), "utf8");
    fs.writeFileSync(
      path.join(targetControlled, "raw-secret.txt"),
      "NVIDIA_API_KEY=nvapi-secret\n",
    );
    fs.symlinkSync(targetControlled, output, "dir");

    runSanitizer(source, output);

    expect(fs.lstatSync(output).isSymbolicLink()).toBe(false);
    expect(fs.statSync(output).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(targetControlled, "raw-secret.txt"))).toBe(true);
    expect(fs.readdirSync(output)).toEqual(["cloud-onboard-trace-timing-summary.json"]);
  });

  it("rejects a symlinked trace source before resolving it", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-trace-source-symlink-"));
    const sourceTarget = path.join(tmp, "raw-target");
    const sourceLink = path.join(tmp, "raw-link");
    const output = path.join(tmp, "summary");
    fs.mkdirSync(sourceTarget);
    fs.writeFileSync(path.join(sourceTarget, "trace.json"), JSON.stringify(makeTrace()), "utf8");
    fs.symlinkSync(sourceTarget, sourceLink, "dir");

    const result = runSanitizerRaw(sourceLink, output);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("trace source must not be a symlink");
    expect(fs.existsSync(output)).toBe(false);
  });
});
