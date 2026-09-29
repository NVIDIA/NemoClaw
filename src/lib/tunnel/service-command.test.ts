// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveDefaultSandboxName,
  resolveDefaultSandboxServiceOptions,
  runStartCommand,
  runStopCommand,
} from "./service-command";
import { readCloudflaredState, startAll } from "./services";

vi.mock("./allowed-origins", () => ({ registerTunnelOrigin: vi.fn() }));

describe("services command", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      NEMOCLAW_SANDBOX_NAME: process.env.NEMOCLAW_SANDBOX_NAME,
      NEMOCLAW_SANDBOX: process.env.NEMOCLAW_SANDBOX,
      SANDBOX_NAME: process.env.SANDBOX_NAME,
    };
    delete process.env.NEMOCLAW_SANDBOX_NAME;
    delete process.env.NEMOCLAW_SANDBOX;
    delete process.env.SANDBOX_NAME;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  });

  it("returns a safe default sandbox name", () => {
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "alpha-1" }))).toBe("alpha-1");
  });

  it("drops an unsafe default sandbox name", () => {
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "bad name" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "../../oops" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: ".hidden" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "-leading-dash" }))).toBeUndefined();
  });

  it("prefers NEMOCLAW_SANDBOX_NAME env var over registry default", () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "env-sandbox";
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "registry-sandbox" }))).toBe(
      "env-sandbox",
    );
  });

  it("prefers NEMOCLAW_SANDBOX env var over registry default", () => {
    process.env.NEMOCLAW_SANDBOX = "env-sandbox-2";
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "registry-sandbox" }))).toBe(
      "env-sandbox-2",
    );
  });

  it("ignores unsafe env var values and falls back to registry", () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "bad name";
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "registry-sandbox" }))).toBe(
      "registry-sandbox",
    );
  });

  it("starts services for the default sandbox when present", async () => {
    const startAll = vi.fn(async () => {});
    await runStartCommand({
      listSandboxes: () => ({ defaultSandbox: "alpha" }),
      getSandbox: () => ({ dashboardPort: 18_791 }),
      startAll,
    });
    expect(startAll).toHaveBeenCalledWith({ sandboxName: "alpha", dashboardPort: 18_791 });
  });

  it("targets the registered dashboard port in the cloudflared process", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nemoclaw-service-command-test-"));
    const pidDir = join(tmpDir, "pids");
    const binDir = join(tmpDir, "bin");
    const fakeCloudflared = join(binDir, "cloudflared");
    const originalPath = process.env.PATH;
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      fakeCloudflared,
      [
        "#!/usr/bin/env sh",
        "printf 'argv:%s\\n' \"$*\"",
        "echo 'https://registered-port.trycloudflare.com'",
        "sleep 20",
      ].join("\n"),
    );
    chmodSync(fakeCloudflared, 0o700);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runStartCommand({
        listSandboxes: () => ({ defaultSandbox: "alpha" }),
        getSandbox: () => ({ dashboardPort: 18_791 }),
        startAll: (options) => startAll({ ...options, pidDir }),
      });

      expect(readFileSync(join(pidDir, "cloudflared.log"), "utf8")).toContain(
        "argv:tunnel --url http://localhost:18791",
      );
    } finally {
      const state = readCloudflaredState(pidDir);
      const runningPid = state.kind === "running" ? state.pid : Number.NaN;
      try {
        process.kill(runningPid, "SIGTERM");
      } catch {
        // Process may have already exited.
      }
      process.env.PATH = originalPath;
      logSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps the service fallback when the selected sandbox is not registered", () => {
    expect(
      resolveDefaultSandboxServiceOptions({
        listSandboxes: () => ({ defaultSandbox: "alpha" }),
        getSandbox: () => null,
      }),
    ).toEqual({ sandboxName: "alpha" });
  });

  it("stops services without a sandbox override when the default sandbox is unsafe", () => {
    const stopAll = vi.fn();
    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: "bad name" }),
      stopAll,
    });
    expect(stopAll).toHaveBeenCalledWith({ sandboxName: undefined });
  });

  it("opts the legacy full-stop command into managed gateway release", () => {
    const stopAll = vi.fn();
    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: "alpha" }),
      stopAll,
      releaseGatewayPort: true,
    });
    expect(stopAll).toHaveBeenCalledWith({ sandboxName: "alpha", releaseGatewayPort: true });
  });
});
