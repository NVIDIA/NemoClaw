// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  captureManagedImageOnboardPairingDiagnostics,
  managedHermesBoundaryPoisonCommand,
  managedOpenClawSubagentCommand,
  preclean,
  summarizeOnboardFailureStartupSignals,
} from "../live/managed-image-activation-e2e-helpers.ts";

describe("managed image activation failure diagnostics", () => {
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
});
