// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDockerGpuMode, type DockerGpuPatchResult } from "./docker-gpu-patch";
import { captureDockerGpuPreRollbackDiagnostics } from "./docker-gpu-pre-rollback-diagnostics";

function patchResult(): DockerGpuPatchResult {
  return {
    applied: true,
    oldContainerId: "old-container-id",
    newContainerId: "new-container-id",
    originalName: "openshell-alpha",
    backupContainerName: "backup-container",
    mode: buildDockerGpuMode("cdi"),
    backupRemoved: false,
  };
}

describe("Docker GPU pre-rollback diagnostics (#6110)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("captures the failed clone state, process topology, and logs before rollback", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const writeFileSpy = vi.spyOn(fs, "writeFileSync");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gpu-pre-rollback-"));
    const secretCanary = "pre-rollback-secret-canary-value";
    const discoveredSecretCanary = "discovered-only-secret-canary-value";
    const callbackSecretCanary = "callback-only-secret-canary-value";
    const inspectOutput = JSON.stringify([
      {
        Id: "new-container-id",
        Image: `sha256:${"f".repeat(64)}`,
        Name: "/openshell-alpha",
        Created: "2026-07-01T22:59:00Z",
        RestartCount: 2,
        Config: {
          Image: "openshell/sandbox:test",
          Cmd: null,
          Env: [
            `OPENSHELL_SANDBOX_COMMAND=env NEMOCLAW_EXTRA_PLACEHOLDER_KEYS=CUSTOM_PROVIDER_CREDENTIAL CUSTOM_PROVIDER_CREDENTIAL=${secretCanary} nemoclaw-start`,
          ],
          Labels: {
            "openshell.ai/sandbox-name": "alpha",
            "untrusted.secret": secretCanary,
          },
        },
        HostConfig: { NetworkMode: "openshell-docker" },
        State: {
          Status: "running",
          Running: true,
          ExitCode: 0,
          StartedAt: "2026-07-01T22:59:01Z",
          FinishedAt: "0001-01-01T00:00:00Z",
          Health: { Status: "healthy", FailingStreak: 0 },
        },
        NetworkSettings: { Networks: { "openshell-docker": {} } },
      },
    ]);
    const discoveredInspectOutput = JSON.stringify([
      {
        Id: "discovered-container-id",
        Config: {
          Env: [
            `OPENSHELL_SANDBOX_COMMAND=env NEMOCLAW_EXTRA_PLACEHOLDER_KEYS=DISCOVERED_CUSTOM_VALUE DISCOVERED_CUSTOM_VALUE=${discoveredSecretCanary} nemoclaw-start`,
          ],
        },
      },
    ]);
    const dockerResponses = new Map([
      [
        "ps -a --no-trunc --filter label=openshell.ai/managed-by=openshell --filter label=openshell.ai/sandbox-name=alpha --format {{.ID}}",
        "new-container-id\ndiscovered-container-id\n",
      ],
      [
        "ps -a --filter label=openshell.ai/managed-by=openshell --filter label=openshell.ai/sandbox-name=alpha",
        `new-container-id ${secretCanary} ${discoveredSecretCanary}\n`,
      ],
      [
        "top new-container-id -eo user,pid,ppid,stat,comm",
        `USER PID PPID STAT COMMAND\nsandbox 42 1 S nemoclaw-start-${secretCanary}\n`,
      ],
      [
        "inspect --format {{json .State}} new-container-id",
        JSON.stringify({ Status: "running", Running: true, ExitCode: 0 }),
      ],
      ["inspect new-container-id", inspectOutput],
      ["inspect old-container-id", "[]"],
      ["inspect backup-container", "[]"],
      ["inspect discovered-container-id", discoveredInspectOutput],
      [
        "exec new-container-id sh -c test -f /tmp/nemoclaw-start.log && tail -n 240 /tmp/nemoclaw-start.log",
        `managed startup active ${callbackSecretCanary}\n`,
      ],
      [
        "exec new-container-id sh -c test -f /tmp/gateway.log && tail -n 240 /tmp/gateway.log",
        `OpenClaw gateway active ${callbackSecretCanary}\n`,
      ],
    ]);
    const dockerCapture = vi.fn((args: readonly string[], _options?: Record<string, unknown>) => {
      return dockerResponses.get(args.join(" ")) ?? "";
    });
    const openshellResponses = new Map([
      [
        "sandbox get",
        `Id: openshell-sandbox-id\nPhase: Error\ndetail=${secretCanary} ${discoveredSecretCanary}\n`,
      ],
      ["sandbox list", `alpha  Error  ${secretCanary} ${discoveredSecretCanary}\n`],
      ["--version", "openshell 0.0.101\n"],
      ["forward list", `alpha 18789 failed ${callbackSecretCanary}\n`],
      ["doctor logs", `gateway reconnect log ${callbackSecretCanary}\n`],
    ]);
    const runCaptureOpenshell = vi.fn(
      (args: string[], _options?: Record<string, unknown>) =>
        openshellResponses.get(`${args[0] ?? ""} ${args[1] ?? ""}`.trim()) ??
        `gateway reconnect log ${secretCanary}\n`,
    );
    const dockerLogs = vi.fn((target: string, _options?: { tail?: number; timeout?: number }) =>
      target === "new-container-id" ? `failed clone log ${secretCanary}\n` : "",
    );

    try {
      const captured = captureDockerGpuPreRollbackDiagnostics(
        "alpha",
        patchResult(),
        {
          dockerCapture,
          dockerLogs,
          homedir: () => tmpDir,
          now: () => new Date("2026-07-01T23:00:00Z"),
          runCaptureOpenshell,
        },
        {
          captureStage: "post-cutover-pre-cleanup",
          additionalSensitiveValues: [callbackSecretCanary],
          additionalSummaryLines: [
            "recreate_reason=messaging_credential_rotation",
            "changed_credential_hash_providers=alpha-discord-bridge",
          ],
          cleanupReason: "dashboard_forward_start_failed",
          cleanupStartedAt: "2026-07-01T23:00:01Z",
          lifecycleGeneration: "generation-2",
          lifecycleObservationDroppedCount: 3,
          lifecycleObservations: [
            {
              at: "2026-07-01T23:00:00Z",
              stage: "sandbox_readiness",
              event: "phase_probe",
              output: `alpha Ready ${callbackSecretCanary}`,
            },
          ],
          forwardDiagnostic: `sandbox is not ready ${callbackSecretCanary}`,
          forwardListOutput: `alpha 18789 dead ${callbackSecretCanary}`,
        },
      );
      const diagnostics = captured?.diagnostics;

      expect(diagnostics?.dir).toBeTruthy();
      const summary = fs.readFileSync(path.join(diagnostics?.dir ?? "", "summary.txt"), "utf-8");
      expect(diagnostics?.cleanupCommands).toEqual([]);
      expect(summary).toContain("capture_stage=post_cutover_pre_cleanup");
      expect(summary).toContain("rolled_back=not_applicable");
      expect(summary).toContain("cleanup_disposition=pending_sandbox_delete");
      expect(summary).toContain("cleanup_required=unknown");
      expect(summary).toContain("lifecycle_generation=generation-2");
      expect(summary).toContain("lifecycle_history_dropped=3");
      expect(summary).toContain("expected_container_id=new-container-id");
      expect(summary).toContain("container_identity_match=ambiguous");
      expect(summary).toContain("cleanup_reason=dashboard_forward_start_failed");
      expect(summary).toContain("changed_credential_hash_providers=alpha-discord-bridge");
      expect(summary).toMatch(/openshell_identity_fingerprint=[a-f0-9]{64}/);
      expect(summary).not.toContain("openshell sandbox delete");
      expect(
        fs.readFileSync(path.join(diagnostics?.dir ?? "", "docker-top.txt"), "utf-8"),
      ).toContain("nemoclaw-start");
      expect(
        fs.readFileSync(path.join(diagnostics?.dir ?? "", "docker-logs.txt"), "utf-8"),
      ).toContain("failed clone log <REDACTED>");
      const inspect = JSON.parse(
        fs.readFileSync(path.join(diagnostics?.dir ?? "", "docker-inspect.json"), "utf-8"),
      );
      expect(inspect[0]).toMatchObject({
        Id: "new-container-id",
        Image: `sha256:${"f".repeat(64)}`,
        Config: {
          Image: "openshell/sandbox:test",
          Cmd: null,
          Env: ["OPENSHELL_SANDBOX_COMMAND=<REDACTED>"],
        },
        HostConfig: { NetworkMode: "openshell-docker" },
        Created: "2026-07-01T22:59:00Z",
        RestartCount: 2,
        State: {
          Status: "running",
          Running: true,
          ExitCode: 0,
          StartedAt: "2026-07-01T22:59:01Z",
          FinishedAt: "0001-01-01T00:00:00Z",
          Health: { Status: "healthy", FailingStreak: 0 },
        },
      });
      expect(
        fs.readFileSync(path.join(diagnostics?.dir ?? "", "lifecycle-history.json"), "utf-8"),
      ).toContain("alpha Ready <REDACTED>");
      expect(
        fs.readFileSync(path.join(diagnostics?.dir ?? "", "forward-start.txt"), "utf-8"),
      ).toContain("sandbox is not ready <REDACTED>");
      expect(
        fs.readFileSync(path.join(diagnostics?.dir ?? "", "openshell-version.txt"), "utf-8"),
      ).toContain("openshell 0.0.101");
      expect(
        fs.readFileSync(path.join(diagnostics?.dir ?? "", "openshell-forward-list.txt"), "utf-8"),
      ).toContain("alpha 18789 failed <REDACTED>");
      expect(
        fs.readFileSync(path.join(diagnostics?.dir ?? "", "managed-startup.log"), "utf-8"),
      ).toContain("managed startup active <REDACTED>");
      expect(
        fs.readFileSync(path.join(diagnostics?.dir ?? "", "openclaw-gateway.log"), "utf-8"),
      ).toContain("OpenClaw gateway active <REDACTED>");
      const diagnosticContents = fs
        .readdirSync(diagnostics?.dir ?? "")
        .map((name) => fs.readFileSync(path.join(diagnostics?.dir ?? "", name), "utf-8"))
        .join("\n");
      expect(diagnosticContents).not.toContain(secretCanary);
      expect(diagnosticContents).not.toContain(discoveredSecretCanary);
      expect(diagnosticContents).not.toContain(callbackSecretCanary);
      expect(diagnosticContents).not.toContain("untrusted.secret");
      const returnedClassification = JSON.stringify(captured?.classification);
      expect(returnedClassification).not.toContain(secretCanary);
      expect(returnedClassification).not.toContain(discoveredSecretCanary);
      expect(returnedClassification).toContain("<REDACTED>");
      const fullInspectCalls = dockerCapture.mock.calls
        .map(([args], index) => ({ args, order: dockerCapture.mock.invocationCallOrder[index] }))
        .filter(({ args }) => args[0] === "inspect" && args[1] !== "--format");
      expect(fullInspectCalls.map(({ args }) => args[1])).toEqual(
        expect.arrayContaining([
          "new-container-id",
          "old-container-id",
          "backup-container",
          "discovered-container-id",
        ]),
      );
      expect(Math.max(...fullInspectCalls.map(({ order }) => order ?? 0))).toBeLessThan(
        writeFileSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
      );
      expect(dockerCapture).toHaveBeenCalledWith(
        ["top", "new-container-id", "-eo", "user,pid,ppid,stat,comm"],
        expect.objectContaining({ ignoreError: true, timeout: expect.any(Number) }),
      );
      for (const [, options] of dockerCapture.mock.calls) {
        expect(Number(options?.timeout)).toBeLessThanOrEqual(2_000);
      }
      for (const [, options] of runCaptureOpenshell.mock.calls) {
        expect(Number(options?.timeout)).toBeLessThanOrEqual(2_000);
      }
      for (const [, options] of dockerLogs.mock.calls) {
        expect(Number(options?.timeout)).toBeLessThanOrEqual(2_000);
      }
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Pre-cleanup diagnostics saved:"),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("retains exit code 127 without assigning a cause when the bundle cannot be created (#7996)", () => {
    const dockerResponses = new Map([
      [
        "inspect --format {{json .State}} new-container-id",
        JSON.stringify({ Status: "exited", Running: false, ExitCode: 127 }),
      ],
    ]);
    const dockerCapture = vi.fn(
      (args: readonly string[]) => dockerResponses.get(args.join(" ")) ?? "",
    );
    const openshellResponses = new Map([
      ["sandbox get", "Phase: Error\n"],
      ["sandbox list", "alpha  Error\n"],
    ]);
    const runCaptureOpenshell = vi.fn(
      (args: string[]) => openshellResponses.get(`${args[0] ?? ""} ${args[1] ?? ""}`.trim()) ?? "",
    );

    const captured = captureDockerGpuPreRollbackDiagnostics("alpha", patchResult(), {
      dockerCapture,
      dockerLogs: vi.fn(() => "nemoclaw-start: child process returned status 127\n"),
      homedir: () => "relative-home",
      runCaptureOpenshell,
    });

    expect(captured?.diagnostics).toBeNull();
    expect(captured?.classification).toMatchObject({
      kind: "patched_container_failed",
      headline: expect.stringContaining("exited with code 127"),
      summaryLines: expect.arrayContaining(["patched_container_exit_code=127"]),
    });
    expect(captured?.classification.hints ?? []).toEqual([]);
  });

  it("captures replacement state before optional enrichment exhausts the shared budget (#7996)", () => {
    const clock = [0, 0, 0, 0];
    vi.spyOn(Date, "now").mockImplementation(() => clock.shift() ?? 10_001);
    const dockerCapture = vi.fn((args: readonly string[]) =>
      args.join(" ") === "inspect --format {{json .State}} new-container-id"
        ? JSON.stringify({ Status: "exited", Running: false, ExitCode: 127 })
        : "",
    );
    const runCaptureOpenshell = vi.fn((args: string[]) =>
      args.join(" ") === "sandbox get alpha" ? "Phase: Error\n" : "alpha  Error\n",
    );

    const captured = captureDockerGpuPreRollbackDiagnostics("alpha", patchResult(), {
      dockerCapture,
      dockerLogs: vi.fn(() => ""),
      homedir: () => "relative-home",
      runCaptureOpenshell,
    });

    expect(captured?.classification).toMatchObject({
      kind: "patched_container_failed",
      summaryLines: expect.arrayContaining(["patched_container_exit_code=127"]),
    });
    expect(dockerCapture).toHaveBeenCalledTimes(1);
    expect(dockerCapture).toHaveBeenCalledWith(
      ["inspect", "--format", "{{json .State}}", "new-container-id"],
      expect.objectContaining({ timeout: 2_000 }),
    );
  });

  it.each([
    ["GNU", "/usr/bin/env: \u2018nemoclaw-start\u2019: No such file or directory\n"],
    ["BusyBox", "env: can't execute 'nemoclaw-start': No such file or directory\n"],
  ])("adds missing-startup guidance for the %s env error (#7996)", (_env, dockerLog) => {
    const dockerResponses = new Map([
      [
        "inspect --format {{json .State}} new-container-id",
        JSON.stringify({ Status: "exited", Running: false, ExitCode: 127 }),
      ],
    ]);
    const dockerCapture = vi.fn(
      (args: readonly string[]) => dockerResponses.get(args.join(" ")) ?? "",
    );
    const openshellResponses = new Map([
      ["sandbox get", "Phase: Error\n"],
      ["sandbox list", "alpha  Error\n"],
    ]);
    const runCaptureOpenshell = vi.fn(
      (args: string[]) => openshellResponses.get(`${args[0] ?? ""} ${args[1] ?? ""}`.trim()) ?? "",
    );

    const captured = captureDockerGpuPreRollbackDiagnostics("alpha", patchResult(), {
      dockerCapture,
      dockerLogs: vi.fn(() => dockerLog),
      homedir: () => "relative-home",
      runCaptureOpenshell,
    });

    expect(captured?.classification.hints).toEqual(
      expect.arrayContaining([expect.stringContaining("NemoClaw-managed `nemoclaw-start`")]),
    );
  });

  it("redacts snapshot values when the shared capture budget expires before collector inspect", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = [0, 0, 0, 0, 0, 0, 0, 0];
    vi.spyOn(Date, "now").mockImplementation(() => clock.shift() ?? 10_001);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gpu-budget-redaction-"));
    const canary = "opaque-budget-value-71f4";
    const inspectOutput = JSON.stringify([
      {
        Id: "new-container-id",
        Config: {
          Env: [
            `OPENSHELL_SANDBOX_COMMAND=env NEMOCLAW_EXTRA_PLACEHOLDER_KEYS=BUDGET_VALUE BUDGET_VALUE=${canary} nemoclaw-start`,
          ],
        },
      },
    ]);
    const dockerResponses = new Map([
      [
        "ps -a --no-trunc --filter label=openshell.ai/managed-by=openshell --filter label=openshell.ai/sandbox-name=alpha --format {{.ID}}",
        "new-container-id\n",
      ],
      ["inspect new-container-id", inspectOutput],
      ["inspect old-container-id", "[]"],
      ["inspect backup-container", "[]"],
      [
        "inspect --format {{json .State}} new-container-id",
        JSON.stringify({ Status: "exited", ExitCode: 125, Error: `state ${canary}` }),
      ],
    ]);
    const openshellResponses = new Map([
      ["sandbox get", `Phase: Error\ndetail=${canary}\n`],
      ["sandbox list", `alpha Error ${canary}\n`],
    ]);

    try {
      const captured = captureDockerGpuPreRollbackDiagnostics("alpha", patchResult(), {
        dockerCapture: vi.fn(
          (args: readonly string[]) => dockerResponses.get(args.join(" ")) ?? "",
        ),
        dockerLogs: vi.fn(() => ""),
        homedir: () => tmpDir,
        now: () => new Date("2026-07-02T01:00:00Z"),
        runCaptureOpenshell: vi.fn(
          (args: string[]) => openshellResponses.get(`${args[0] ?? ""} ${args[1] ?? ""}`) ?? "",
        ),
      });
      const diagnostics = captured?.diagnostics;

      const summary = fs.readFileSync(path.join(diagnostics?.dir ?? "", "summary.txt"), "utf8");
      const state = fs.readFileSync(
        path.join(diagnostics?.dir ?? "", "patched-container-state.json"),
        "utf8",
      );
      expect(`${summary}\n${state}`).not.toContain(canary);
      expect(summary).toContain("sandbox_list_row=alpha Error <REDACTED>");
      expect(summary).toContain("container_identity_query=failed");
      expect(summary).toContain("container_identity_match=unknown");
      expect(JSON.parse(state).Error).toBe("state <REDACTED>");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
