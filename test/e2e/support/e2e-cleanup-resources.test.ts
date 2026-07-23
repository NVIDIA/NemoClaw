// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type CleanupHost, CleanupRegistry } from "../fixtures/cleanup.ts";
import {
  assertCleanupSucceededOrAbsent,
  cleanupAcquiredResource,
  cleanupExistingPath,
  cleanupUnlessVerified,
  cleanupWhenCommandAvailable,
  cleanupWhenOpenShellAvailable,
  registerSandboxCleanupUnlessKept,
  terminateProcessIfRunning,
} from "../fixtures/cleanup-resources.ts";

describe("cleanup resources", () => {
  it("tears down acquired resources in reverse order", async () => {
    const calls: string[] = [];
    const host: CleanupHost = {
      cleanupSandbox: async (name) => {
        calls.push(`sandbox:${name}`);
      },
      cleanupGatewayRegistration: async (name) => {
        calls.push(`gateway:${name}`);
      },
      cleanupForward: async (port) => {
        calls.push(`forward:${port}`);
      },
    };
    const cleanup = new CleanupRegistry();
    cleanup.trackGateway(host, "nemoclaw");
    cleanup.trackSandbox(host, "e2e-resource");
    cleanup.trackForward(host, 18789);

    const result = await cleanup.runAll();
    expect(calls).toEqual(["forward:18789", "sandbox:e2e-resource", "gateway:nemoclaw"]);
    expect(result.failures).toEqual([]);
  });

  it("passes cleanup run options through tracked resources", async () => {
    const calls: Array<{ resource: string; options: unknown }> = [];
    const host: CleanupHost = {
      cleanupSandbox: async (_name, options) => {
        calls.push({ resource: "sandbox", options });
      },
      cleanupGatewayRegistration: async (_name, options) => {
        calls.push({ resource: "gateway", options });
      },
      cleanupForward: async (_port, options) => {
        calls.push({ resource: "forward", options });
      },
    };
    const cleanup = new CleanupRegistry();
    const gatewayOptions = {
      artifactName: "cleanup-gateway",
      env: { OPENSHELL_GATEWAY: "nemoclaw" },
      redactionValues: ["gateway-secret"],
      timeoutMs: 1_000,
    };
    const sandboxOptions = {
      artifactName: "cleanup-sandbox",
      env: { NEMOCLAW_GATEWAY_PORT: "18080" },
      redactionValues: ["sandbox-secret"],
      timeoutMs: 2_000,
    };
    const forwardOptions = {
      artifactName: "cleanup-forward",
      env: { OPENSHELL_GATEWAY: "nemoclaw-18080" },
      redactionValues: ["forward-secret"],
      timeoutMs: 3_000,
    };

    cleanup.trackGateway(host, "nemoclaw", gatewayOptions);
    cleanup.trackSandbox(host, "e2e-resource", sandboxOptions);
    cleanup.trackForward(host, 18789, forwardOptions);

    await cleanup.runAll();
    expect(calls).toEqual([
      { resource: "forward", options: forwardOptions },
      { resource: "sandbox", options: sandboxOptions },
      { resource: "gateway", options: gatewayOptions },
    ]);
  });

  it("supports partial typed setup and runs each registration only once", async () => {
    let calls = 0;
    const host: CleanupHost = {
      cleanupSandbox: async () => {
        calls += 1;
      },
      cleanupGatewayRegistration: async () => {
        throw new Error("unregistered gateway cleanup must not run");
      },
      cleanupForward: async () => {
        throw new Error("unregistered forward cleanup must not run");
      },
    };
    const cleanup = new CleanupRegistry();
    cleanup.trackSandbox(host, "partially-created");

    expect((await cleanup.runAll()).passed).toEqual(["destroy sandbox partially-created"]);
    expect(await cleanup.runAll()).toEqual({ passed: [], failures: [] });
    expect(calls).toBe(1);
  });

  it("registers sandbox cleanup before installer side effects (#7146)", () => {
    for (const fileName of ["full-e2e.test.ts", "hermes-e2e.test.ts"]) {
      const source = fs.readFileSync(
        path.resolve(import.meta.dirname, "..", "live", fileName),
        "utf8",
      );
      const cleanupRegistration = source.indexOf(".trackSandbox(host, SANDBOX_NAME");
      const installerStart = source.indexOf('host.command("bash", ["install.sh"');

      expect(
        cleanupRegistration,
        `${fileName} must register sandbox cleanup`,
      ).toBeGreaterThanOrEqual(0);
      expect(installerStart, `${fileName} must invoke install.sh`).toBeGreaterThan(
        cleanupRegistration,
      );
    }
  });

  it("continues typed cleanup after a resource failure", async () => {
    const calls: string[] = [];
    const host: CleanupHost = {
      cleanupSandbox: async () => {
        calls.push("sandbox");
        throw new Error("sandbox cleanup denied");
      },
      cleanupGatewayRegistration: async () => {
        calls.push("gateway");
      },
      cleanupForward: async () => {
        calls.push("forward");
      },
    };
    const cleanup = new CleanupRegistry();
    cleanup.trackGateway(host, "nemoclaw");
    cleanup.trackSandbox(host, "e2e-resource");
    cleanup.trackForward(host, 18789);

    const result = await cleanup.runAll();
    expect(calls).toEqual(["forward", "sandbox", "gateway"]);
    expect(result).toEqual({
      passed: ["stop forward 18789", "remove gateway nemoclaw"],
      failures: [{ name: "destroy sandbox e2e-resource", message: "sandbox cleanup denied" }],
    });
  });

  it("redacts failures and continues cleanup", async () => {
    const calls: string[] = [];
    const cleanup = new CleanupRegistry((text) => text.replaceAll("secret", "[REDACTED]"));
    cleanup.trackDisposable("later secret cleanup", () => {
      calls.push("later");
    });
    cleanup.trackDisposable("failing secret cleanup", () => {
      throw new Error("secret failure");
    });

    const result = await cleanup.runAll();
    expect(calls).toEqual(["later"]);
    expect(result).toEqual({
      passed: ["later [REDACTED] cleanup"],
      failures: [{ name: "failing [REDACTED] cleanup", message: "[REDACTED] failure" }],
    });
  });

  it("reports failed shields restoration before continuing sandbox cleanup", async () => {
    const calls: string[] = [];
    const cleanup = new CleanupRegistry();
    cleanup.trackDisposable("destroy shields sandbox", () => {
      calls.push("destroy");
    });
    cleanup.trackDisposable("restore shields before destroy", () => {
      calls.push("restore");
      throw new Error("shields up exited 1");
    });

    const result = await cleanup.runAll();
    expect(calls).toEqual(["restore", "destroy"]);
    expect(result).toEqual({
      passed: ["destroy shields sandbox"],
      failures: [{ name: "restore shields before destroy", message: "shields up exited 1" }],
    });
  });

  it("accepts successful or explicitly absent cleanup results and rejects other failures (#6352)", () => {
    expect(() =>
      assertCleanupSucceededOrAbsent(
        { exitCode: 0, stderr: "", stdout: "removed" },
        false,
        "remove resource",
      ),
    ).not.toThrow();
    expect(() =>
      assertCleanupSucceededOrAbsent(
        { exitCode: 1, stderr: "resource not found", stdout: "" },
        /not found/i,
        "remove resource",
      ),
    ).not.toThrow();
    expect(() =>
      assertCleanupSucceededOrAbsent(
        { exitCode: 1, stderr: "already absent", stdout: "" },
        true,
        "remove resource",
      ),
    ).not.toThrow();
    expect(() =>
      assertCleanupSucceededOrAbsent(
        { exitCode: 1, stderr: "permission denied", stdout: "" },
        /not found/i,
        "remove resource",
      ),
    ).toThrow("remove resource failed: permission denied");
  });

  it("runs acquired and existing-path cleanup only after acquisition (#6352)", async () => {
    const cleanup = vi.fn(async () => {});
    await cleanupAcquiredResource(false, cleanup);
    await cleanupAcquiredResource(true, cleanup);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cleanup-resource-"));
    const marker = path.join(directory, "acquired");
    fs.writeFileSync(marker, "acquired", "utf8");
    await cleanupExistingPath(marker, () => fs.rmSync(marker));
    await cleanupExistingPath(marker, cleanup);
    fs.rmSync(directory, { recursive: true, force: true });

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not repeat cleanup after explicit teardown has been verified (#6352)", async () => {
    const cleanup = vi.fn(async () => {});
    await cleanupUnlessVerified(true, cleanup);
    await cleanupUnlessVerified(false, cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("runs command-owned cleanup only when the managing command is available (#6352)", async () => {
    const isCommandAvailable = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const cleanup = vi.fn(async () => {});
    const probeOptions = { artifactName: "cleanup-command-probe", timeoutMs: 1_000 };

    await cleanupWhenCommandAvailable({ isCommandAvailable }, "openshell", probeOptions, cleanup);
    await cleanupWhenCommandAvailable({ isCommandAvailable }, "openshell", probeOptions, cleanup);

    expect(isCommandAvailable).toHaveBeenCalledTimes(2);
    expect(isCommandAvailable).toHaveBeenNthCalledWith(1, "openshell", probeOptions);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("uses the configured OpenShell command and preserves strict cleanup failures (#6352)", async () => {
    const isCommandAvailable = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const host = {
      isCommandAvailable,
      openshellCommandPath: "/opt/openshell/bin/openshell",
    };
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("permission denied"));
    const probeOptions = { artifactName: "cleanup-openshell-probe", timeoutMs: 1_000 };

    await cleanupWhenOpenShellAvailable(host, probeOptions, cleanup);
    await expect(cleanupWhenOpenShellAvailable(host, probeOptions, cleanup)).rejects.toThrow(
      "permission denied",
    );

    expect(isCommandAvailable).toHaveBeenNthCalledWith(
      1,
      "/opt/openshell/bin/openshell",
      probeOptions,
    );
    expect(isCommandAvailable).toHaveBeenNthCalledWith(
      2,
      "/opt/openshell/bin/openshell",
      probeOptions,
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not register destructive sandbox cleanup when retention is requested (#6352)", () => {
    const register = vi.fn();
    registerSandboxCleanupUnlessKept(true, register);
    registerSandboxCleanupUnlessKept(false, register);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("tolerates only an already-exited process during termination (#6352)", () => {
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("already exited"), { code: "ESRCH" });
    });
    expect(() => terminateProcessIfRunning(1234)).not.toThrow();

    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    expect(() => terminateProcessIfRunning(1234)).toThrow("not permitted");

    kill.mockImplementationOnce(() => true);
    terminateProcessIfRunning(1234, "SIGKILL");
    expect(kill).toHaveBeenLastCalledWith(1234, "SIGKILL");
  });
});
