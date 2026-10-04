// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { trackOverlayfsAutofixCleanup } from "../live/overlayfs-autofix-cleanup.ts";
import { negativeOverlayOutcome } from "../live/overlayfs-autofix-outcome.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function shellProbeResult(overrides: Partial<ShellProbeResult>): ShellProbeResult {
  return {
    command: ["timeout", "300", "bash", "install.sh", "--non-interactive"],
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
    ...overrides,
  };
}

function cleanupClients(calls: string[]): {
  command: ReturnType<typeof vi.fn>;
  host: Pick<HostCliClient, "cleanupGatewayRegistration" | "cleanupSandbox" | "command">;
  sandbox: Pick<SandboxClient, "cleanupSandbox">;
} {
  const command = vi
    .fn()
    .mockImplementationOnce(async () => {
      calls.push("remove gateway container");
      return shellProbeResult({ exitCode: 0 });
    })
    .mockImplementationOnce(async () => {
      calls.push("list patched images");
      return shellProbeResult({ exitCode: 0, stdout: "" });
    });
  return {
    command,
    host: {
      command,
      cleanupGatewayRegistration: async () => {
        calls.push("remove gateway registration");
      },
      cleanupSandbox: async () => {
        calls.push("destroy NemoClaw sandbox");
      },
    },
    sandbox: {
      cleanupSandbox: async () => {
        calls.push("delete OpenShell sandbox");
      },
    },
  };
}

describe("overlayfs autofix negative outcome classifier", () => {
  it("treats nested-overlay evidence as a reproduced failure", () => {
    expect(
      negativeOverlayOutcome(
        shellProbeResult({ exitCode: 1 }),
        "k3s failed: overlayfs snapshotter cannot be enabled",
      ),
    ).toBe("reproduced");
  });

  it("treats only the inner GNU timeout exit 124 as timeout non-reproduction", () => {
    expect(negativeOverlayOutcome(shellProbeResult({ exitCode: 124 }), "no signature")).toBe(
      "timeout",
    );
  });

  it("does not classify outer ShellProbe supervisor timeout as timeout non-reproduction", () => {
    expect(
      negativeOverlayOutcome(
        shellProbeResult({ exitCode: null, signal: "SIGKILL", timedOut: true }),
        "no signature",
      ),
    ).toBe("unrelated");
  });
});

describe("overlayfs autofix cleanup resources", () => {
  it("does not register destructive cleanup when the sandbox is preserved (#6352)", async () => {
    const calls: string[] = [];
    const { command, host, sandbox } = cleanupClients(calls);
    const cleanup = new CleanupRegistry();
    trackOverlayfsAutofixCleanup({
      cleanup,
      cleanupEnv: {},
      gatewayContainer: "nemoclaw-gateway",
      host,
      preserveSandbox: true,
      redactionValues: [],
      sandbox,
      sandboxName: "e2e-overlayfs-autofix",
    });

    expect(await cleanup.runAll()).toEqual({ failures: [], passed: [] });
    expect(command).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("tears down sandbox resources before gateway artifacts in LIFO order (#6352)", async () => {
    const calls: string[] = [];
    const { host, sandbox } = cleanupClients(calls);
    const cleanup = new CleanupRegistry();
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => {});
    trackOverlayfsAutofixCleanup({
      cleanup,
      cleanupEnv: { OPENSHELL_GATEWAY: "nemoclaw" },
      gatewayContainer: "nemoclaw-gateway",
      host,
      preserveSandbox: false,
      redactionValues: ["cleanup-secret"],
      sandbox,
      sandboxName: "e2e-overlayfs-autofix",
    });

    const result = await cleanup.runAll();
    expect(result.failures).toEqual([]);
    expect(calls).toEqual([
      "destroy NemoClaw sandbox",
      "delete OpenShell sandbox",
      "remove gateway registration",
      "remove gateway container",
      "list patched images",
    ]);
    expect(remove).toHaveBeenCalledWith(expect.stringContaining(".nemoclaw/onboard.lock"), {
      force: true,
    });
  });

  it("continues image and lock cleanup after gateway container removal fails (#6352)", async () => {
    const calls: string[] = [];
    const { command, host, sandbox } = cleanupClients(calls);
    command.mockReset();
    command
      .mockImplementationOnce(async () => {
        calls.push("remove gateway container");
        return shellProbeResult({ exitCode: 1, stderr: "permission denied" });
      })
      .mockImplementationOnce(async () => {
        calls.push("list patched images");
        return shellProbeResult({ exitCode: 0, stdout: "" });
      });
    const cleanup = new CleanupRegistry();
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => {});
    trackOverlayfsAutofixCleanup({
      cleanup,
      cleanupEnv: {},
      gatewayContainer: "nemoclaw-gateway",
      host,
      preserveSandbox: false,
      redactionValues: [],
      sandbox,
      sandboxName: "e2e-overlayfs-autofix",
    });

    const result = await cleanup.runAll();
    expect(result.failures).toEqual([
      {
        message: "remove overlayfs gateway container failed: permission denied",
        name: "remove overlayfs gateway container",
      },
    ]);
    expect(calls).toEqual([
      "destroy NemoClaw sandbox",
      "delete OpenShell sandbox",
      "remove gateway registration",
      "remove gateway container",
      "list patched images",
    ]);
    expect(remove).toHaveBeenCalledOnce();
  });
});
