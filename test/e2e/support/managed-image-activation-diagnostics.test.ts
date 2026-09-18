// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  captureManagedImageOnboardPairingDiagnostics,
  managedActivationOpenClawPluginScript,
  managedHermesBoundaryPoisonCommand,
  managedOpenClawSubagentCommand,
  preclean,
  summarizeOnboardFailureStartupSignals,
  verifyExactCleanup,
} from "../live/managed-image-activation-e2e-helpers.ts";

type CleanupListOptions = Parameters<Parameters<typeof verifyExactCleanup>[1]["list"]>[0];

function commandResult(stdout: string, exitCode = 0, stderr = "") {
  return {
    command: ["fixture"],
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
    artifacts: { stdout: "", stderr: "", result: "" },
  };
}

describe("managed image activation failure diagnostics", () => {
  it("installs activation proof plugins through native OpenClaw ownership", () => {
    const script = managedActivationOpenClawPluginScript();

    expect(script).toContain('openclaw plugins install "$source_dir" --force');
    expect(script).toContain("/sandbox/managed-activation-native-plugin");
    expect(script).not.toContain("plugins.allow");
    expect(script).not.toContain("openclawImagePluginInstalls");
  });

  it("prepares the Hermes restart refusal through the native .env boundary", () => {
    const command = managedHermesBoundaryPoisonCommand();
    expect(command).toContain("/sandbox/.hermes/.env");
    expect(command).toContain("DEVTEST_API_TOKEN=");
    expect(command).not.toContain("gateway restart");
  });

  it("drives the managed OpenClaw caller through sessions_spawn", () => {
    expect(managedOpenClawSubagentCommand("subagent-proof")).toEqual(
      expect.arrayContaining([
        "subagent-proof",
        expect.stringContaining("use sessions_spawn once"),
      ]),
    );
  });

  it("emits only the fixed setup signal from arbitrary container output (#8543)", () => {
    const secret = "untrusted-prompt-and-credential";
    const summary = summarizeOnboardFailureStartupSignals(
      [
        secret,
        "Setting up NemoClaw (Hermes)...",
        "Hermes runtime config guard refuses mutation under a foreign PID 1",
      ].join("\n"),
    );

    expect(summary.setupStarted).toBe(true);
    expect(summary).toEqual({ setupStarted: true });
    expect(Object.values(summary).every((value) => typeof value === "boolean")).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it("captures bounded pairing stages only for OpenClaw onboarding failures (#9844)", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0 }));

    await captureManagedImageOnboardPairingDiagnostics(
      { exec } as never,
      "openclaw",
      "mi-act-openclaw",
      { PATH: "/usr/bin" },
    );
    await captureManagedImageOnboardPairingDiagnostics(
      { exec } as never,
      "hermes",
      "mi-act-hermes",
      { PATH: "/usr/bin" },
    );

    expect(exec).toHaveBeenCalledExactlyOnceWith(
      "mi-act-openclaw",
      ["node", "-e", expect.any(String), "/tmp/auto-pair.log", "/tmp/gateway.log"],
      expect.objectContaining({
        artifactName: "failure-openclaw-pairing-diagnostics",
        redactionValues: ["nemoclaw-managed-activation-e2e-key"],
      }),
    );
  });
  it("initializes cleanup then removes gateway state before cold onboarding", async () => {
    const calls: string[] = [];
    const host = {
      command: vi.fn(async () => {
        calls.push("start");
        return { exitCode: 0 };
      }),
      bestEffortCleanupSandbox: vi.fn(async () => {
        calls.push("destroy");
      }),
      cleanupGatewayRegistration: vi.fn(async () => {
        calls.push("remove-registration");
      }),
    };
    const lifecycle = {
      stopGatewayRuntime: vi.fn(async () => {
        calls.push("stop");
      }),
    };
    const sandbox = {
      cleanupSandbox: vi.fn(async () => {
        calls.push("delete");
      }),
    };
    await preclean(host as never, lifecycle as never, sandbox as never, "mi-act-openclaw", {
      HOME: "/job/home",
      OPENSHELL_GATEWAY: "nemoclaw",
    });
    expect(calls).toEqual(["start", "destroy", "delete", "stop", "remove-registration"]);
    expect(host.command).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["nemoclaw"]),
      expect.objectContaining({ env: { HOME: "/job/home", OPENSHELL_GATEWAY: "nemoclaw" } }),
    );
    host.command.mockRejectedValueOnce(new Error("startup failed"));
    calls.length = 0;
    await expect(
      preclean(host as never, lifecycle as never, sandbox as never, "mi-act-openclaw", {
        OPENSHELL_GATEWAY: "nemoclaw",
      }),
    ).rejects.toThrow("startup failed");
    expect(calls).toEqual([]);
  });

  it("waits for a transient Deleting sandbox before verifying Docker cleanup", async () => {
    const sandbox = {
      list: vi
        .fn()
        .mockResolvedValueOnce(commandResult("NAME PHASE\nmi-act-hermes Deleting\n"))
        .mockResolvedValueOnce(commandResult("No sandboxes found.\n")),
    };
    const host = {
      command: vi.fn(async () => commandResult("")),
    };

    await verifyExactCleanup(
      host,
      sandbox,
      "mi-act-hermes",
      { OPENSHELL_GATEWAY: "nemoclaw" },
      {
        attempts: 2,
        intervalMs: 0,
      },
    );

    expect(sandbox.list).toHaveBeenCalledTimes(2);
    expect(sandbox.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ artifactName: "post-destroy-openshell-list-mi-act-hermes-2" }),
    );
    expect(host.command).toHaveBeenCalledExactlyOnceWith(
      "docker",
      ["ps", "-aq", "--filter", "label=openshell.ai/sandbox-name=mi-act-hermes"],
      expect.objectContaining({ artifactName: "post-destroy-docker-inventory-mi-act-hermes" }),
    );
  });

  it("bounds cleanup convergence and preserves the last OpenShell inventory", async () => {
    const deleting = commandResult("NAME PHASE\nmi-act-hermes Deleting\n");
    const sandbox = { list: vi.fn(async () => deleting) };
    const host = { command: vi.fn() };

    await expect(
      verifyExactCleanup(host, sandbox, "mi-act-hermes", {}, { attempts: 2, intervalMs: 0 }),
    ).rejects.toThrow(/remained present after 2 cleanup probes within 60000ms:.*Deleting/su);
    expect(sandbox.list).toHaveBeenCalledTimes(2);
    expect(host.command).not.toHaveBeenCalled();
  });

  it("caps probes to the remaining cleanup deadline", async () => {
    vi.useFakeTimers();
    try {
      const deleting = commandResult("NAME PHASE\nmi-act-hermes Deleting\n");
      const sandbox = { list: vi.fn(async (_options: CleanupListOptions) => deleting) };
      const host = { command: vi.fn() };
      const verification = verifyExactCleanup(
        host,
        sandbox,
        "mi-act-hermes",
        {},
        {
          attempts: 10,
          intervalMs: 1_000,
          timeoutMs: 1_500,
        },
      );
      const rejected = expect(verification).rejects.toThrow(
        /remained present after 2 cleanup probes within 1500ms:.*Deleting/su,
      );

      await vi.advanceTimersByTimeAsync(1_500);
      await rejected;

      expect(sandbox.list).toHaveBeenCalledTimes(2);
      expect(sandbox.list.mock.calls[0]?.[0]?.timeoutMs).toBeLessThanOrEqual(1_500);
      expect(sandbox.list.mock.calls[1]?.[0]?.timeoutMs).toBeLessThanOrEqual(500);
      expect(host.command).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails immediately when the OpenShell inventory probe errors", async () => {
    const sandbox = {
      list: vi.fn(async () => commandResult("", 1, "gateway unavailable")),
    };
    const host = { command: vi.fn() };

    await expect(
      verifyExactCleanup(host, sandbox, "mi-act-hermes", {}, { attempts: 3, intervalMs: 0 }),
    ).rejects.toThrow(/list OpenShell sandboxes.*gateway unavailable/u);
    expect(sandbox.list).toHaveBeenCalledTimes(1);
    expect(host.command).not.toHaveBeenCalled();
  });
});
