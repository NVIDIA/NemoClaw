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
  waitForManagedActivationSandboxAbsence,
} from "../live/managed-image-activation-e2e-helpers.ts";

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

  it("waits for a deleting managed activation sandbox to become absent", async () => {
    vi.useFakeTimers();
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: "NAME            CREATED   PHASE\nmi-act-hermes   1m        Deleting\n",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: "NAME   CREATED   PHASE\n",
      });

    try {
      const absence = waitForManagedActivationSandboxAbsence({ list } as never, "mi-act-hermes", {
        OPENSHELL_GATEWAY: "nemoclaw",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await absence;
    } finally {
      vi.useRealTimers();
    }

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        artifactName: "post-destroy-openshell-list-mi-act-hermes-attempt-01",
      }),
    );
    expect(list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        artifactName: "post-destroy-openshell-list-mi-act-hermes-attempt-02",
      }),
    );
  });

  it("fails when OpenShell still lists the managed activation sandbox at the cleanup deadline", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "NAME            CREATED   PHASE\nmi-act-hermes   1m        Deleting\n",
    }));

    try {
      const absence = waitForManagedActivationSandboxAbsence({ list } as never, "mi-act-hermes", {
        OPENSHELL_GATEWAY: "nemoclaw",
      });
      const assertion = expect(absence).rejects.toThrow("polling exhausted its configured bound");
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    expect(list.mock.calls.length).toBeGreaterThan(1);
  });

  it("stops when OpenShell cannot list sandboxes during cleanup verification", async () => {
    const list = vi.fn(async () => ({
      exitCode: 1,
      stderr: "gateway transport unavailable",
      stdout: "",
    }));

    await expect(
      waitForManagedActivationSandboxAbsence({ list } as never, "mi-act-hermes", {
        OPENSHELL_GATEWAY: "nemoclaw",
      }),
    ).rejects.toThrow("list OpenShell sandboxes after managed activation destroy failed");
    expect(list).toHaveBeenCalledOnce();
  });
});
