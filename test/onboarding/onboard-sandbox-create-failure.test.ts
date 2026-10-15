// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const docker = vi.hoisted(() => ({
  dockerRun: vi.fn(),
  dockerCapture: vi.fn(),
  dockerLogs: vi.fn(),
}));

vi.mock("../../src/lib/adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/adapters/docker")>()),
  dockerRun: docker.dockerRun,
  dockerCapture: docker.dockerCapture,
  dockerLogs: docker.dockerLogs,
}));

import {
  collectSandboxCreateFailureDiagnostics,
  printSandboxCreateFailureDiagnostics,
} from "../../src/lib/onboard/sandbox-create-failure.js";

const LANDLOCK_FAILURE =
  'Error:   × Failed to prepare sandbox: Landlock path unavailable in hard_requirement mode: /does-not-exist (path does not exist): failed to open "/does-not-exist": No such file or directory (os error 2)';

function captureConsoleError<T>(action: () => T): { result: T; messages: string[] } {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => {
    messages.push(String(message ?? ""));
  };
  try {
    return { result: action(), messages };
  } finally {
    console.error = originalError;
  }
}

describe("sandbox create failure diagnostics", () => {
  beforeEach(() => {
    docker.dockerRun.mockReset().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    docker.dockerCapture.mockReset().mockReturnValue("");
    docker.dockerLogs.mockReset().mockReturnValue("");
  });

  it.each([
    ["default port", 8080, undefined, "openshell-docker-gateway"],
    ["non-default port", 9123, undefined, "openshell-docker-gateway-9123"],
    ["configured state", 9123, "configured-gateway", "configured-gateway"],
  ] as const)(
    "reads the selected %s gateway log before the legacy fallback (#10544)",
    (_scenario, gatewayPort, configuredDirName, expectedDirName) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-selected-log-"));
      const homeDir = path.join(tmp, "home");
      const gatewayStateDir = configuredDirName
        ? path.join(tmp, configuredDirName)
        : path.join(homeDir, ".local", "state", "nemoclaw", expectedDirName);
      const gatewayLogPath = path.join(gatewayStateDir, "openshell-gateway.log");
      fs.mkdirSync(gatewayStateDir, { recursive: true });
      fs.writeFileSync(gatewayLogPath, "selected gateway exited before sandbox creation\n");

      const diagnostics = collectSandboxCreateFailureDiagnostics("my-assistant", {
        gatewayPort,
        gatewayStateDir: configuredDirName ? gatewayStateDir : undefined,
        homeDir,
        now: new Date("2026-05-12T20:35:00.000Z"),
      });

      expect(diagnostics?.gatewayLogPath).toBe(gatewayLogPath);
      expect(diagnostics?.summaryLines).toContain(
        "selected gateway exited before sandbox creation",
      );
    },
  );

  it("preserves gateway failure lines and VM console output before cleanup", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-"));
    const homeDir = path.join(tmp, "home");
    const logDir = path.join(homeDir, ".local", "state", "nemoclaw", "openshell-docker-gateway");
    const sandboxId = "691344ae-f514-41c1-b29e-db7f2f7ef257";
    const stateDir = path.join(logDir, "vm-driver", "sandboxes", sandboxId);
    const consolePath = path.join(stateDir, "rootfs-console.log");
    const gatewayLogPath = path.join(logDir, "openshell-gateway.log");

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(consolePath, "vm console detail\n");
    fs.writeFileSync(
      gatewayLogPath,
      [
        "old unrelated line",
        `2026-05-12T20:30:56Z INFO vm driver: create_sandbox received sandbox_id=${sandboxId} sandbox_name=my-assistant`,
        `2026-05-12T20:30:56Z INFO vm driver: resolved image ref, preparing rootfs sandbox_id=${sandboxId} state_dir=${stateDir}`,
        `2026-05-12T20:34:28Z INFO vm driver: spawning VM launcher sandbox_id=${sandboxId} console_output=${consolePath}`,
        "[2026-05-12T20:34:29Z ERROR krun] Building the microVM failed: Internal(Vm(VmSetup(VmCreate)))",
        `2026-05-12T20:34:29Z WARN Sandbox failed to become ready sandbox_id=${sandboxId} sandbox_name=my-assistant reason=ProcessExited`,
      ].join("\n"),
    );

    const diagnostics = collectSandboxCreateFailureDiagnostics("my-assistant", {
      homeDir,
      backupPath: "/tmp/pre-upgrade-backup",
      now: new Date("2026-05-12T20:35:00.000Z"),
    });

    expect(diagnostics?.sandboxId).toBe(sandboxId);
    expect(diagnostics?.copiedConsoleOutput).toBe(
      path.join(diagnostics!.dir, "rootfs-console.log"),
    );
    expect(fs.readFileSync(path.join(diagnostics!.dir, "rootfs-console.log"), "utf-8")).toContain(
      "vm console detail",
    );
    const relevant = fs.readFileSync(
      path.join(diagnostics!.dir, "openshell-gateway-relevant.log"),
      "utf-8",
    );
    expect(relevant).toContain("VmCreate");
    expect(relevant).toContain("sandbox_name=my-assistant");
    expect(fs.readFileSync(path.join(diagnostics!.dir, "summary.txt"), "utf-8")).toContain(
      "backup_path=/tmp/pre-upgrade-backup",
    );
  });

  it("prints saved diagnostics and retained backup details", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-print-"));
    const homeDir = path.join(tmp, "home");
    const messages: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      messages.push(String(message ?? ""));
    };

    try {
      const diagnostics = printSandboxCreateFailureDiagnostics("my-assistant", {
        homeDir,
        backupPath: "/tmp/pre-upgrade-backup",
        sandboxContainerOutput: null,
        now: new Date("2026-05-12T20:35:00.000Z"),
      });

      expect(diagnostics?.dir).toContain(path.join(homeDir, ".nemoclaw", "onboard-failures"));
      expect(messages).toContain(`  Diagnostics saved: ${diagnostics!.dir}`);
      expect(messages).toContain("  State backup retained: /tmp/pre-upgrade-backup");
    } finally {
      console.error = originalError;
    }
  });

  it("preserves a bounded gateway tail when sandbox-specific lines are absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-tail-"));
    const homeDir = path.join(tmp, "home");
    const logDir = path.join(homeDir, ".local", "state", "nemoclaw", "openshell-docker-gateway");
    const gatewayLogPath = path.join(logDir, "openshell-gateway.log");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      gatewayLogPath,
      [
        "2026-05-12T20:30:00Z INFO gateway starting",
        "2026-05-12T20:30:01Z WARN gateway exited before request dispatch",
      ].join("\n"),
    );

    const diagnostics = collectSandboxCreateFailureDiagnostics("my-assistant", {
      homeDir,
      now: new Date("2026-05-12T20:35:00.000Z"),
    });

    expect(diagnostics?.gatewayTailPath).toBe(
      path.join(diagnostics!.dir, "openshell-gateway-tail.log"),
    );
    expect(fs.readFileSync(diagnostics!.gatewayTailPath!, "utf-8")).toContain(
      "gateway exited before request dispatch",
    );
    expect(diagnostics?.summaryLines).toContain(
      "2026-05-12T20:30:01Z WARN gateway exited before request dispatch",
    );
    expect(fs.readFileSync(path.join(diagnostics!.dir, "summary.txt"), "utf-8")).toContain(
      "gateway_tail=",
    );
  });

  // OpenShell 0.0.116 prints supervisor startup failures only to the sandbox
  // container's stderr; neither `openshell logs` nor sandbox status carry the
  // reason (#13178). Remove once the OpenShell pin reaches 0.1.0.
  it("captures, saves, and prints redacted sandbox container output through Docker (#13178)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-container-"));
    const homeDir = path.join(tmp, "home");
    const containerId = "f".repeat(64);
    const keyedSecret = "nvapi-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
    const opaqueSecret = "opaque-value-9f8e7d6c5b4a";
    docker.dockerRun.mockReturnValue({ status: 0, stdout: `${containerId}\n`, stderr: "" });
    docker.dockerCapture.mockImplementation((args: readonly string[]) =>
      args.includes("--format")
        ? ""
        : JSON.stringify([{ Config: { Env: [`PROVIDER_TOKEN=${opaqueSecret}`] }, State: {} }]),
    );
    docker.dockerLogs.mockReturnValue(
      [
        "2026-10-14T18:32:23.679Z OCSF CONFIG:APPLYING [INFO] Applying Landlock filesystem sandbox",
        `2026-10-14T18:32:23.680Z INFO provider env NVIDIA_API_KEY=${keyedSecret}`,
        `2026-10-14T18:32:23.681Z INFO provider said ${opaqueSecret}`,
        LANDLOCK_FAILURE,
      ].join("\n"),
    );

    const { result: diagnostics, messages } = captureConsoleError(() =>
      printSandboxCreateFailureDiagnostics("my-assistant", {
        homeDir,
        now: new Date("2026-10-14T18:35:00.000Z"),
      }),
    );

    expect(docker.dockerRun.mock.calls[0][0]).toEqual(
      expect.arrayContaining(["label=openshell.ai/sandbox-name=my-assistant"]),
    );
    expect(docker.dockerLogs).toHaveBeenCalledWith(containerId, expect.anything());
    const savedPath = path.join(diagnostics!.dir, "sandbox-container.log");
    expect(diagnostics?.sandboxContainerLogPath).toBe(savedPath);
    const saved = fs.readFileSync(savedPath, "utf-8");
    expect(saved).toContain(LANDLOCK_FAILURE);
    expect(fs.statSync(savedPath).mode & 0o777).toBe(0o600);
    expect(messages).toContain("  Recent sandbox container output:");
    expect(messages).toContain(`    ${LANDLOCK_FAILURE}`);
    const printed = messages.join("\n");
    expect(saved).not.toContain(keyedSecret);
    expect(saved).not.toContain(opaqueSecret);
    expect(printed).not.toContain(keyedSecret);
    expect(printed).not.toContain(opaqueSecret);
    expect(fs.readFileSync(path.join(diagnostics!.dir, "summary.txt"), "utf-8")).toContain(
      `sandbox_container_log=${savedPath}`,
    );
  });

  it("uses output captured before rollback instead of reading Docker again (#13178)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-captured-"));
    const { messages } = captureConsoleError(() =>
      printSandboxCreateFailureDiagnostics("my-assistant", {
        homeDir: path.join(tmp, "home"),
        now: new Date("2026-10-14T18:35:00.000Z"),
        sandboxContainerOutput: LANDLOCK_FAILURE,
      }),
    );

    expect(docker.dockerRun).not.toHaveBeenCalled();
    expect(docker.dockerLogs).not.toHaveBeenCalled();
    expect(messages).toContain(`    ${LANDLOCK_FAILURE}`);
  });

  it("omits sandbox container output when capture found none (#13178)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-no-container-"));
    const { result: diagnostics, messages } = captureConsoleError(() =>
      printSandboxCreateFailureDiagnostics("my-assistant", {
        homeDir: path.join(tmp, "home"),
        now: new Date("2026-10-14T18:35:00.000Z"),
        sandboxContainerOutput: null,
      }),
    );

    expect(diagnostics?.sandboxContainerLogPath).toBeNull();
    expect(fs.existsSync(path.join(diagnostics!.dir, "sandbox-container.log"))).toBe(false);
    expect(messages).not.toContain("  Recent sandbox container output:");
  });
});
