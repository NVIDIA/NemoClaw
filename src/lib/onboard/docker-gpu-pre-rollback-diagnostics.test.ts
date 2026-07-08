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
    const inspectOutput = JSON.stringify([
      {
        Id: "new-container-id",
        Name: "/openshell-alpha",
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
        "ps -a --filter label=openshell.ai/managed-by=openshell --filter label=openshell.ai/sandbox-name=alpha --format {{.ID}}",
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
    ]);
    const dockerCapture = vi.fn((args: readonly string[], _options?: Record<string, unknown>) => {
      return dockerResponses.get(args.join(" ")) ?? "";
    });
    const openshellResponses = new Map([
      ["sandbox get", `Phase: Error\ndetail=${secretCanary} ${discoveredSecretCanary}\n`],
      ["sandbox list", `alpha  Error  ${secretCanary} ${discoveredSecretCanary}\n`],
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
      const diagnostics = captureDockerGpuPreRollbackDiagnostics("alpha", patchResult(), {
        dockerCapture,
        dockerLogs,
        homedir: () => tmpDir,
        now: () => new Date("2026-07-01T23:00:00Z"),
        runCaptureOpenshell,
      });

      expect(diagnostics?.dir).toBeTruthy();
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
        Config: {
          Image: "openshell/sandbox:test",
          Cmd: null,
          Env: ["OPENSHELL_SANDBOX_COMMAND=<REDACTED>"],
        },
        HostConfig: { NetworkMode: "openshell-docker" },
      });
      const diagnosticContents = fs
        .readdirSync(diagnostics?.dir ?? "")
        .map((name) => fs.readFileSync(path.join(diagnostics?.dir ?? "", name), "utf-8"))
        .join("\n");
      expect(diagnosticContents).not.toContain(secretCanary);
      expect(diagnosticContents).not.toContain(discoveredSecretCanary);
      expect(diagnosticContents).not.toContain("untrusted.secret");
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
        expect.stringContaining("Pre-rollback diagnostics saved:"),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
        "ps -a --filter label=openshell.ai/managed-by=openshell --filter label=openshell.ai/sandbox-name=alpha --format {{.ID}}",
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
      const diagnostics = captureDockerGpuPreRollbackDiagnostics("alpha", patchResult(), {
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

      const summary = fs.readFileSync(path.join(diagnostics?.dir ?? "", "summary.txt"), "utf8");
      const state = fs.readFileSync(
        path.join(diagnostics?.dir ?? "", "patched-container-state.json"),
        "utf8",
      );
      expect(`${summary}\n${state}`).not.toContain(canary);
      expect(summary).toContain("sandbox_list_row=alpha Error <REDACTED>");
      expect(JSON.parse(state).Error).toBe("state <REDACTED>");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
