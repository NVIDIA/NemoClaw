// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RunResult } from "../../adapters/uninstall/commands";
import { writeCompleteDockerDriverGatewayLocalTlsBundle } from "../../onboard/__test-helpers__/docker-driver-gateway-local-tls";
import { getDockerDriverGatewayLocalTlsBundle } from "../../onboard/docker-driver-gateway-local-tls";
import {
  deleteAllSelectedGatewaySandboxes,
  selectedGatewayCleanupRuntimeSelection,
} from "./runtime-commands";

function result(status: number | null, stdout = "", stderr = "", error?: Error): RunResult {
  return { status, stdout, stderr, ...(error ? { error } : {}) };
}

describe("uninstall bulk sandbox cleanup", () => {
  it("uses complete selected-gateway TLS state for deletion and inventory (#11831)", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-tls-"));
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const runtime = {
      env: { PATH: "/usr/bin" },
      log: vi.fn(),
      run: (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ args, env: options?.env });
        return args[1] === "list" ? result(0, "No sandboxes found.\n") : result(0, "deleted");
      },
      sleep: vi.fn(),
      warn: vi.fn(),
    };

    try {
      writeCompleteDockerDriverGatewayLocalTlsBundle(stateDir);
      const selection = selectedGatewayCleanupRuntimeSelection("nemoclaw-8091", stateDir);

      await expect(deleteAllSelectedGatewaySandboxes(runtime, selection)).resolves.toBe(true);

      const localTlsDir = getDockerDriverGatewayLocalTlsBundle(stateDir).localTlsDir;
      expect(calls.map(({ args }) => args)).toEqual([
        ["sandbox", "delete", "--all"],
        ["sandbox", "list"],
        ["sandbox", "list"],
      ]);
      expect(calls.every(({ env }) => env?.OPENSHELL_LOCAL_TLS_DIR === localTlsDir)).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("omits selected-gateway TLS authority when its state bundle is incomplete (#11831)", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-tls-"));
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const runtime = {
      env: { PATH: "/usr/bin", OPENSHELL_LOCAL_TLS_DIR: "/hostile/tls" },
      log: vi.fn(),
      run: (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ args, env: options?.env });
        return args[1] === "list" ? result(0, "No sandboxes found.\n") : result(0, "deleted");
      },
      sleep: vi.fn(),
      warn: vi.fn(),
    };

    try {
      writeCompleteDockerDriverGatewayLocalTlsBundle(stateDir);
      fs.rmSync(getDockerDriverGatewayLocalTlsBundle(stateDir).clientKeyPath);
      const selection = selectedGatewayCleanupRuntimeSelection("nemoclaw-8091", stateDir);

      await expect(deleteAllSelectedGatewaySandboxes(runtime, selection)).resolves.toBe(true);

      expect(selection.localTlsDir).toBeUndefined();
      expect(calls).toHaveLength(3);
      expect(calls.every(({ env }) => env?.OPENSHELL_LOCAL_TLS_DIR === undefined)).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("deletes once and requires stable empty selected-gateway inventory (#11831)", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const logs: string[] = [];
    const runtime = {
      env: {
        PATH: "/usr/bin",
        NVIDIA_API_KEY: "must-not-leak",
        OPENSHELL_GATEWAY: "foreign",
        OPENSHELL_GATEWAY_ENDPOINT: "https://foreign.invalid",
      },
      log: (message: string) => logs.push(message),
      run: (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ args, env: options?.env });
        return args[1] === "list" ? result(0, "No sandboxes found.\n") : result(0, "deleted");
      },
      sleep: vi.fn(),
      warn: vi.fn(),
    };

    await expect(
      deleteAllSelectedGatewaySandboxes(runtime, {
        gatewayName: "nemoclaw-8091",
        workspace: "default",
        localTlsDir: "/authority/tls",
      }),
    ).resolves.toBe(true);

    expect(calls.map(({ args }) => args)).toEqual([
      ["sandbox", "delete", "--all"],
      ["sandbox", "list"],
      ["sandbox", "list"],
    ]);
    expect(calls.every(({ env }) => env?.NVIDIA_API_KEY === undefined)).toBe(true);
    expect(calls.every(({ env }) => env?.OPENSHELL_GATEWAY === "nemoclaw-8091")).toBe(true);
    expect(calls.every(({ env }) => env?.OPENSHELL_WORKSPACE === "default")).toBe(true);
    expect(calls.every(({ env }) => env?.OPENSHELL_LOCAL_TLS_DIR === "/authority/tls")).toBe(true);
    expect(calls.every(({ env }) => env?.OPENSHELL_GATEWAY_ENDPOINT === undefined)).toBe(true);
    expect(runtime.sleep).toHaveBeenCalledOnce();
    expect(logs).toContain("Deleted all OpenShell sandboxes");
  });

  it("reconciles an ambiguous deletion without submitting it again (#11831)", async () => {
    const calls: string[][] = [];
    const warnings: string[] = [];
    const runtime = {
      env: { PATH: "/usr/bin" },
      log: vi.fn(),
      run: (_command: string, args: string[]) => {
        calls.push(args);
        return args[1] === "delete"
          ? result(null, "", "", Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }))
          : result(0, "No sandboxes found.\n");
      },
      sleep: vi.fn(),
      warn: (message: string) => warnings.push(message),
    };

    await expect(
      deleteAllSelectedGatewaySandboxes(runtime, {
        gatewayName: "nemoclaw-8091",
        workspace: "default",
      }),
    ).resolves.toBe(true);

    expect(calls.filter((args) => args[1] === "delete")).toHaveLength(1);
    expect(calls.filter((args) => args[1] === "list")).toHaveLength(2);
    expect(warnings).toContain("OpenShell sandboxes already removed or unreachable");
  });

  it("preserves cleanup authority when empty inventory is not stable (#11831)", async () => {
    const inventory = [
      "No sandboxes found.\n",
      "alpha Ready\n",
      "No sandboxes found.\n",
      "alpha Ready\n",
      "No sandboxes found.\n",
    ];
    const calls: string[][] = [];
    const warnings: string[] = [];
    const runtime = {
      env: { PATH: "/usr/bin" },
      log: vi.fn(),
      run: (_command: string, args: string[]) => {
        calls.push(args);
        return args[1] === "list" ? result(0, inventory.shift()) : result(0, "accepted");
      },
      sleep: vi.fn(),
      warn: (message: string) => warnings.push(message),
    };

    await expect(
      deleteAllSelectedGatewaySandboxes(runtime, {
        gatewayName: "nemoclaw-8091",
        workspace: "default",
      }),
    ).resolves.toBe(false);

    expect(calls.filter((args) => args[1] === "delete")).toHaveLength(1);
    expect(calls.filter((args) => args[1] === "list")).toHaveLength(5);
    expect(warnings).toContain(
      "OpenShell sandbox cleanup was incomplete; preserving its state for retry.",
    );
  });

  it("preserves cleanup authority when inventory cannot be verified (#11831)", async () => {
    const calls: string[][] = [];
    const warnings: string[] = [];
    const runtime = {
      env: { PATH: "/usr/bin" },
      log: vi.fn(),
      run: (_command: string, args: string[]) => {
        calls.push(args);
        return args[1] === "list" ? result(1, "", "permission denied") : result(0, "accepted");
      },
      sleep: vi.fn(),
      warn: (message: string) => warnings.push(message),
    };

    await expect(
      deleteAllSelectedGatewaySandboxes(runtime, {
        gatewayName: "nemoclaw-8091",
        workspace: "default",
      }),
    ).resolves.toBe(false);

    expect(calls.filter((args) => args[1] === "delete")).toHaveLength(1);
    expect(calls.filter((args) => args[1] === "list")).toHaveLength(5);
    expect(warnings).toEqual([
      expect.stringContaining(
        "inventory could not be verified: OpenShell could not authenticate the sandbox observation.",
      ),
    ]);
  });
});
