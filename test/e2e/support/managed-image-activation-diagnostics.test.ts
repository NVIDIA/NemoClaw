// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  captureManagedImageOnboardPairingDiagnostics,
  collectOnboardFailureDockerDiagnostics,
  managedActivationOpenClawPluginScript,
  managedHermesBoundaryPoisonCommand,
  managedOpenClawSubagentCommand,
  ONBOARD_FAILURE_LOG_ARTIFACT_OPTIONS,
  preclean,
  summarizeOnboardFailureStartupSignals,
  waitForManagedActivationSandboxDeletion,
} from "../live/managed-image-activation-e2e-helpers.ts";

describe("managed image activation failure diagnostics", () => {
  it("waits only for the exact OpenShell Deleting phase and records each observation", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: "NAME CREATED PHASE\nmi-act-dcode now Deleting\n",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: "NAME CREATED PHASE\nmi-act-dcode now Deleting\n",
      })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "NAME CREATED PHASE\n" });
    const settleSleep = vi.fn(async () => {});

    const result = await waitForManagedActivationSandboxDeletion(
      { list } as never,
      "mi-act-dcode",
      { OPENSHELL_GATEWAY: "nemoclaw" },
      { sleep: settleSleep },
    );

    expect(result.stdout).not.toContain("mi-act-dcode");
    expect(settleSleep.mock.calls).toEqual([[1_000], [1_000]]);
    expect(list.mock.calls.map((call) => call[0]?.artifactName)).toEqual([
      "post-destroy-openshell-list-mi-act-dcode-attempt-1",
      "post-destroy-openshell-list-mi-act-dcode-attempt-2",
      "post-destroy-openshell-list-mi-act-dcode-attempt-3",
    ]);
  });

  it("does not retry a live sandbox or hide a persistent deletion", async () => {
    const ready = {
      exitCode: 0,
      stderr: "",
      stdout: "NAME CREATED PHASE\nmi-act-dcode now Ready\n",
    };
    const readyList = vi.fn(async () => ready);
    const readySleep = vi.fn(async () => {});
    await expect(
      waitForManagedActivationSandboxDeletion(
        { list: readyList } as never,
        "mi-act-dcode",
        {},
        { sleep: readySleep },
      ),
    ).resolves.toBe(ready);
    expect(readyList).toHaveBeenCalledOnce();
    expect(readySleep).not.toHaveBeenCalled();

    const deleting = {
      exitCode: 0,
      stderr: "",
      stdout: "NAME CREATED PHASE\nmi-act-dcode now Deleting\n",
    };
    const deletingList = vi.fn(async () => deleting);
    const deletingSleep = vi.fn(async () => {});
    await expect(
      waitForManagedActivationSandboxDeletion(
        { list: deletingList } as never,
        "mi-act-dcode",
        {},
        { sleep: deletingSleep },
      ),
    ).resolves.toBe(deleting);
    expect(deletingList).toHaveBeenCalledTimes(4);
    expect(deletingSleep.mock.calls).toEqual([[1_000], [1_000], [1_000]]);

    const failed = {
      exitCode: 1,
      stderr: "gateway unavailable",
      stdout: "mi-act-dcode now Deleting\n",
    };
    const failedList = vi.fn(async () => failed);
    const failedSleep = vi.fn(async () => {});
    await expect(
      waitForManagedActivationSandboxDeletion(
        { list: failedList } as never,
        "mi-act-dcode",
        {},
        { sleep: failedSleep },
      ),
    ).resolves.toBe(failed);
    expect(failedList).toHaveBeenCalledOnce();
    expect(failedSleep).not.toHaveBeenCalled();
  });

  it("retains redacted Docker logs for failed startup diagnosis", () => {
    expect(ONBOARD_FAILURE_LOG_ARTIFACT_OPTIONS).toEqual({ persistArtifacts: true });
  });

  it("redacts a copied failed-startup log before artifact publication", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-startup-diagnostics-"));
    const secret = "supplied-startup-diagnostic-secret";
    const containerId = "a".repeat(64);
    const artifacts = new ArtifactSink(directory);
    const command = vi.fn(async (executable: string, args: readonly string[]) => {
      switch (`${executable}:${String(args[0])}`) {
        case "docker:ps":
          return {
            exitCode: 0,
            stdout: `${containerId}\tmanaged-container\timage\tExited\n`,
            stderr: "",
          };
        case "docker:cp":
          fs.writeFileSync(String(args[2]), `startup log contains ${secret}\n`);
          break;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    try {
      await collectOnboardFailureDockerDiagnostics(
        artifacts,
        { command } as never,
        "openclaw",
        "managed-openclaw",
        {},
        [secret],
      );

      const published = fs.readFileSync(
        artifacts.pathFor(
          "managed-activation-onboard-failure-openclaw-container-1-nemoclaw-start.log",
        ),
        "utf8",
      );
      expect(published).toContain("[REDACTED]");
      expect(published).not.toContain(secret);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

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
});
