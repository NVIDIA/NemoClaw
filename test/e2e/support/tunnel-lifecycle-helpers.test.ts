// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  classifyCloudflaredLog,
  getCloudflaredLogPath,
  publicTunnelProbeCurlArgs,
  registerTunnelLifecycleCleanup,
} from "../live/tunnel-lifecycle-helpers.ts";

function shellResult(overrides: Partial<ShellProbeResult> = {}): ShellProbeResult {
  return {
    command: ["nemoclaw"],
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: {
      stdout: "stdout.txt",
      stderr: "stderr.txt",
      result: "result.json",
    },
    ...overrides,
  };
}

describe("tunnel lifecycle cleanup registration", () => {
  it("stops the tunnel before destroying the sandbox during registered cleanup", async () => {
    const calls: string[] = [];
    const cleanup = new CleanupRegistry();
    registerTunnelLifecycleCleanup(cleanup, {
      cleanupSandbox: async () => {
        calls.push("destroy");
      },
      nemoclaw: async () => {
        calls.push("stop");
        return shellResult();
      },
    });

    const result = await cleanup.runAll();

    expect(result.failures).toEqual([]);
    expect(calls).toEqual(["stop", "destroy"]);
  });

  it("surfaces unexpected tunnel-stop cleanup failures", async () => {
    const cleanup = new CleanupRegistry();
    registerTunnelLifecycleCleanup(cleanup, {
      cleanupSandbox: async () => {},
      nemoclaw: async () =>
        shellResult({
          exitCode: 1,
          stderr: "permission denied while stopping cloudflared",
        }),
    });

    const result = await cleanup.runAll();

    expect(result.failures).toEqual([
      {
        name: "stop cloudflared quick tunnel",
        message:
          "[NemoClaw fault] cleanup tunnel stop failed with exit 1: permission denied while stopping cloudflared",
      },
    ]);
  });

  it("surfaces unexpected sandbox-destroy cleanup failures", async () => {
    const cleanup = new CleanupRegistry();
    registerTunnelLifecycleCleanup(cleanup, {
      cleanupSandbox: async () => {
        throw new Error("docker daemon denied sandbox destroy");
      },
      nemoclaw: async () => shellResult(),
    });

    const result = await cleanup.runAll();

    expect(result.failures).toEqual([
      {
        name: "destroy sandbox e2e-tunnel-lifecycle",
        message: "docker daemon denied sandbox destroy",
      },
    ]);
  });

  it("suppresses already-stopped tunnel cleanup states", async () => {
    const cleanup = new CleanupRegistry();
    registerTunnelLifecycleCleanup(cleanup, {
      cleanupSandbox: async () => {},
      nemoclaw: async () => shellResult({ exitCode: 1, stderr: "no active tunnel" }),
    });

    const result = await cleanup.runAll();

    expect(result.failures).toEqual([]);
  });
});

describe("tunnel lifecycle cloudflared log attribution", () => {
  it("does not follow redirects from the public trycloudflare probe", () => {
    expect(publicTunnelProbeCurlArgs("https://current.trycloudflare.com/")).toEqual([
      "-sS",
      "--max-time",
      "30",
      "-w",
      "\n__HTTP_CODE:%{http_code}\n",
      "https://current.trycloudflare.com/",
    ]);
  });

  it("does not attribute an unrelated newer cloudflared log to the current sandbox", () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-lifecycle-logs-"));
    const unrelatedDir = path.join(logRoot, "nemoclaw-services-other-sandbox");
    fs.mkdirSync(unrelatedDir, { recursive: true });
    fs.writeFileSync(
      path.join(unrelatedDir, "cloudflared.log"),
      "https://unrelated.trycloudflare.com captured by another run\n",
    );

    try {
      expect(getCloudflaredLogPath(logRoot, "e2e-tunnel-lifecycle-current")).toBeUndefined();
      expect(classifyCloudflaredLog(logRoot, "e2e-tunnel-lifecycle-current")).toBe(
        "nemoclaw_no_spawn",
      );
    } finally {
      fs.rmSync(logRoot, { recursive: true, force: true });
    }
  });

  it("classifies only the sandbox-specific cloudflared log", () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-lifecycle-logs-"));
    const sandboxDir = path.join(logRoot, "nemoclaw-services-e2e-tunnel-lifecycle-current");
    fs.mkdirSync(sandboxDir, { recursive: true });
    const sandboxLog = path.join(sandboxDir, "cloudflared.log");
    fs.writeFileSync(sandboxLog, "https://current.trycloudflare.com\n");

    try {
      expect(getCloudflaredLogPath(logRoot, "e2e-tunnel-lifecycle-current")).toBe(sandboxLog);
      expect(classifyCloudflaredLog(logRoot, "e2e-tunnel-lifecycle-current")).toBe(
        "nemoclaw_capture_bug",
      );
    } finally {
      fs.rmSync(logRoot, { recursive: true, force: true });
    }
  });

  it("classifies localhost/origin-refused logs as a NemoClaw local-origin fault", () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-lifecycle-logs-"));
    const sandboxDir = path.join(logRoot, "nemoclaw-services-e2e-tunnel-lifecycle-current");
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(
      path.join(sandboxDir, "cloudflared.log"),
      'ERR Request failed error="Unable to reach the origin service. dial tcp 127.0.0.1:18789: connect: connection refused"\n',
    );

    try {
      expect(classifyCloudflaredLog(logRoot, "e2e-tunnel-lifecycle-current")).toBe(
        "nemoclaw_local",
      );
    } finally {
      fs.rmSync(logRoot, { recursive: true, force: true });
    }
  });

  it("classifies representative quick-tunnel registration failures as Cloudflare faults", () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-lifecycle-logs-"));
    const sandboxDir = path.join(logRoot, "nemoclaw-services-e2e-tunnel-lifecycle-current");
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(
      path.join(sandboxDir, "cloudflared.log"),
      "ERR failed to unmarshal quick Tunnel response: tunnel server returned 503 bad gateway\n",
    );

    try {
      expect(classifyCloudflaredLog(logRoot, "e2e-tunnel-lifecycle-current")).toBe("cloudflare");
    } finally {
      fs.rmSync(logRoot, { recursive: true, force: true });
    }
  });
});
