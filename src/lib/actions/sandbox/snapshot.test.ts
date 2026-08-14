// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializedLlamaCppHostLocalInferenceReceipt } from "../../../../test/helpers/host-local-inference-receipt";
import { createSandboxHostLocalInferenceProvenance } from "../../state/registry/host-local-inference";
import {
  type DcodeProbeState,
  dcodeProbeOutput,
  framedDcodeProbeOutput,
} from "./dcode-probe-test-fixture";
import { SANDBOX_EXEC_STARTED_MARKER } from "./sandbox-exec-output";
import * as f from "./snapshot-restore-test-fixture";

const dcodeSandboxEntry = {
  name: "alpha",
  agent: "langchain-deepagents-code",
};

describe("runSandboxSnapshot", () => {
  beforeEach(() => {
    f.resetSnapshotRestoreMocks();
  });

  afterEach(() => {
    f.cleanupSnapshotRestoreMocks();
  });

  function mockDcodeProbe(state: DcodeProbeState, output = "") {
    mockDcodeProbeResult({ status: 0, output: dcodeProbeOutput(state, output) });
  }

  function mockDcodeProbeResult(result: f.OpenshellCaptureResult) {
    f.captureOpenshellMock.mockImplementation((args: string[]) => {
      return f.openshellResponses(args, {
        "sandbox exec": result,
        "sandbox list": {
          status: 0,
          output: "alpha Ready\n",
        },
      });
    });
  }

  function capturedDcodeProbeScript(): string {
    const execArgs =
      f.captureOpenshellMock.mock.calls
        .map(([args]) => args)
        .find((args) => args[0] === "sandbox" && args[1] === "exec") ?? [];
    return String(execArgs.at(-1) ?? "");
  }

  function runProbeScriptWithProcesses(
    script: string,
    processes: string,
  ): {
    status: number;
    output: string;
  } {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-probe-"));
    const psPath = path.join(tempDir, "ps");
    const homeDir = path.join(tempDir, "home");
    fs.mkdirSync(homeDir);
    fs.writeFileSync(psPath, `#!/bin/sh\ncat <<'EOF'\n${processes}\nEOF\n`);
    fs.chmodSync(psPath, 0o755);
    const result = spawnSync("sh", ["-c", script], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: `${tempDir}:/usr/bin:/bin`,
      },
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
    return { status: result.status ?? 255, output: result.stdout || "" };
  }

  it("refuses snapshot creation before backup when the shields gate helper is unavailable", async () => {
    f.shieldsMock.setIsShieldsDownExport(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify shields state. Refusing to create snapshot.",
    );
  });

  it("creates a named snapshot after gateway, liveness, and shields checks pass", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const manifest = {
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      name: "before-upgrade",
    };
    f.backupSandboxStateMock.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      backedUpFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
      manifest,
    });
    f.findBackupMock.mockReturnValue({
      match: { ...manifest, snapshotVersion: 7, name: "before-upgrade" },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", {
      kind: "create",
      name: "before-upgrade",
    });

    expect(f.backupSandboxStateMock).toHaveBeenCalledWith("alpha", {
      name: "before-upgrade",
    });
    expect(f.findBackupMock).toHaveBeenCalledWith("alpha", manifest.timestamp);
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Creating snapshot of 'alpha' (--name before-upgrade)");
    expect(output).toContain("Snapshot v7 name=before-upgrade created");
    expect(output).toContain("/tmp/backup-alpha");
  });

  it("refuses snapshot creation before backup when a dcode task is active", async () => {
    f.getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbe("active", "123 python3 -m deepagents_code -n write a script\n");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
    expect(
      f.captureOpenshellMock.mock.calls.some(
        ([args]) =>
          args[0] === "sandbox" &&
          args[1] === "exec" &&
          args.includes("--name") &&
          args.includes("alpha"),
      ),
    ).toBe(true);
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Sandbox is actively running a dcode task. Please retry after the task completes.",
    );
  });

  it("refuses an active dcode task even when registry metadata is missing", async () => {
    mockDcodeProbe("active", "123 python3 -m deepagents_code --sandbox none --no-mcp -n work\n");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Sandbox is actively running a dcode task. Please retry after the task completes.",
    );
  });

  it("allows dcode snapshot creation when the process probe finds no active task", async () => {
    f.getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbe("idle");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const manifest = {
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      name: "idle",
    };
    f.backupSandboxStateMock.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      backedUpFiles: ["config.toml"],
      failedDirs: [],
      failedFiles: [],
      manifest,
    });
    f.findBackupMock.mockReturnValue({
      match: { ...manifest, snapshotVersion: 8, name: "idle" },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "create", name: "idle" });

    expect(f.backupSandboxStateMock).toHaveBeenCalledWith("alpha", {
      name: "idle",
    });
    expect(consoleLog.mock.calls.flat().join("\n")).toContain("Snapshot v8 name=idle created");
  });

  it("allows dcode snapshot creation when OpenShell frames the probe stdout", async () => {
    f.getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbeResult({ status: 0, output: framedDcodeProbeOutput("idle") });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const manifest = {
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      name: "framed-idle",
    };
    f.backupSandboxStateMock.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      backedUpFiles: ["config.toml"],
      failedDirs: [],
      failedFiles: [],
      manifest,
    });
    f.findBackupMock.mockReturnValue({
      match: { ...manifest, snapshotVersion: 9, name: "framed-idle" },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "create", name: "framed-idle" });

    expect(f.backupSandboxStateMock).toHaveBeenCalledWith("alpha", { name: "framed-idle" });
    expect(consoleLog.mock.calls.flat().join("\n")).toContain(
      "Snapshot v9 name=framed-idle created",
    );
    const execCall = f.captureOpenshellMock.mock.calls.find(
      ([args]) => args[0] === "sandbox" && args[1] === "exec",
    );
    expect(execCall?.[1]).toMatchObject({ ignoreError: true, includeStreams: true });
    expect(execCall?.[0]).toContain("-c");
    expect(execCall?.[0]).not.toContain("-lc");
    expect(String(execCall?.[0].at(-1) ?? "")).toMatch(
      new RegExp(`${SANDBOX_EXEC_STARTED_MARKER}_[0-9a-f]{32}`),
    );
  });

  it("refuses an active dcode task when OpenShell frames the probe stdout", async () => {
    f.getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbeResult({ status: 0, output: framedDcodeProbeOutput("active", "[stdout] ") });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Sandbox is actively running a dcode task. Please retry after the task completes.",
    );
  });

  it("refuses a probe that repeats its marker after an active state", async () => {
    f.getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbeResult({
      status: 0,
      output: [
        SANDBOX_EXEC_STARTED_MARKER,
        "NEMOCLAW_DCODE_PROBE=active",
        SANDBOX_EXEC_STARTED_MARKER,
        "NEMOCLAW_DCODE_PROBE=idle",
      ].join("\n"),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task.",
    );
  });

  it("refuses conflicting probe states after one valid marker", async () => {
    f.getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbeResult({
      status: 0,
      output: [
        SANDBOX_EXEC_STARTED_MARKER,
        "NEMOCLAW_DCODE_PROBE=idle",
        "NEMOCLAW_DCODE_PROBE=active",
      ].join("\n"),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task.",
    );
  });

  it("refuses conflicting probe markers split across stdout and stderr", async () => {
    f.getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbeResult({
      status: 0,
      output: "",
      stdout: dcodeProbeOutput("active"),
      stderr: framedDcodeProbeOutput("idle"),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task.",
    );
  });

  it("refuses an idle dcode snapshot when the exec wrapper reports a non-zero status", async () => {
    f.getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbeResult({ status: 1, output: dcodeProbeOutput("idle") });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task. Refusing to create snapshot.",
    );
  });

  it("refuses registered dcode snapshots when raw status 1 has no idle sentinel", async () => {
    f.getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbeResult({ status: 1, output: "exec failed" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task. Refusing to create snapshot.",
    );
  });

  it("refuses registered dcode snapshots when the probe times out", async () => {
    f.getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbeResult({
      status: null,
      output: "",
      error: new Error("timed out"),
      signal: "SIGTERM",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task. Refusing to create snapshot.",
    );
  });

  it("refuses dcode snapshot creation before backup when task state cannot be verified", async () => {
    f.getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbe("unverifiable", "ps: command failed\n");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task. Refusing to create snapshot.",
    );
  });

  it("refuses missing-registry dcode runtime when task state cannot be verified", async () => {
    mockDcodeProbe("unverifiable", "ps: command failed\n");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task. Refusing to create snapshot.",
    );
  });

  it("keeps registered non-dcode snapshots on the existing path when the dcode probe fails", async () => {
    f.getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });
    mockDcodeProbeResult({ status: 1, output: "exec unsupported" });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const manifest = {
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
    };
    f.backupSandboxStateMock.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      backedUpFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
      manifest,
    });
    f.findBackupMock.mockReturnValue({
      match: { ...manifest, snapshotVersion: 3 },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "create" });

    expect(
      f.captureOpenshellMock.mock.calls.some(
        ([args]) => args[0] === "sandbox" && args[1] === "exec",
      ),
    ).toBe(false);
    expect(f.backupSandboxStateMock).toHaveBeenCalledWith("alpha", {
      name: null,
    });
    expect(consoleLog.mock.calls.flat().join("\n")).toContain("Snapshot v3 created");
  });

  it("detects managed dcode process argv without matching the probe shell", async () => {
    mockDcodeProbe("no-runtime");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const manifest = {
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
    };
    f.backupSandboxStateMock.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      backedUpFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
      manifest,
    });
    f.findBackupMock.mockReturnValue({
      match: { ...manifest, snapshotVersion: 3 },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "create" });

    const probeScript = capturedDcodeProbeScript();
    const shellCommandLine = probeScript.replace(/\s+/g, " ");
    for (const processLine of [
      "123 python3 -m deepagents_code --sandbox none --no-mcp -n work\n",
      "123 /opt/venv/bin/python3 -m deepagents_code --sandbox none --no-mcp -n work\n",
      "123 /opt/venv/bin/python3 -I -m deepagents_code --sandbox none --no-mcp -n work\n",
      "124 /usr/local/bin/dcode task\n",
      "125 /opt/bin/deepagents_code task\n",
      "126 /opt/bin/deepagents-code task\n",
    ]) {
      expect(runProbeScriptWithProcesses(probeScript, processLine)).toMatchObject({
        status: 0,
        output: expect.stringContaining("NEMOCLAW_DCODE_PROBE=active"),
      });
    }
    expect(
      runProbeScriptWithProcesses(probeScript, `999 sh -c ${shellCommandLine}\n`),
    ).toMatchObject({
      status: 0,
      output: expect.stringContaining("NEMOCLAW_DCODE_PROBE=no-runtime"),
    });
    for (const processLine of [
      "127 cat /tmp/dcode\n",
      "128 grep deepagents-code notes.txt\n",
      "129 sh -lc python3 -m deepagents_code\n",
    ]) {
      expect(runProbeScriptWithProcesses(probeScript, processLine)).toMatchObject({
        status: 0,
        output: expect.stringContaining("NEMOCLAW_DCODE_PROBE=no-runtime"),
      });
    }
    expect(consoleLog.mock.calls.flat().join("\n")).toContain("Snapshot v3 created");
  }, 15_000);

  it("renders a stable snapshot list with versions, names, timestamps, and paths", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    f.listBackupsMock.mockReturnValue([
      {
        snapshotVersion: 1,
        name: "initial",
        timestamp: "2026-06-01T00:00:00.000Z",
        backupPath: "/tmp/alpha/v1",
      },
      {
        snapshotVersion: 2,
        name: null,
        timestamp: "2026-06-02T00:00:00.000Z",
        backupPath: "/tmp/alpha/v2",
      },
    ]);
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "list" });

    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Snapshots for 'alpha'");
    expect(output).toContain("v1");
    expect(output).toContain("initial");
    expect(output).toContain("/tmp/alpha/v2");
    expect(output).toContain("2 snapshot(s). Restore with:");
  });

  it("prints create, list, and restore usage for the bare help branch", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "help" });

    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Usage:");
    expect(output).toContain("alpha snapshot create");
    expect(output).toContain("alpha snapshot list");
    expect(output).toContain("alpha snapshot restore");
  });

  it("restores the latest snapshot into the source sandbox", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    f.getLatestBackupMock.mockReturnValue({
      snapshotVersion: 4,
      name: "stable",
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
    });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Using latest snapshot v4 name=stable");
    expect(output).toContain("Restoring snapshot into 'alpha'");
    expect(output).toContain("Restored 1 directories, 1 files");
  });

  it("keeps active-timer restore, permission repair, and policy reconciliation serialized", async () => {
    f.lifecycleMock.readTimerMarkerMock.mockReturnValue({
      pid: 4242,
      sandboxName: "alpha",
      snapshotPath: "/tmp/policy.yaml",
      restoreAt: "2026-06-27T06:00:00.000Z",
      processToken: "a".repeat(32),
    });
    f.getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: ["github"],
    });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.lifecycleMock.events).toContain("lock:restore sandbox snapshot");
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");
    expect(f.shieldsMock.repairMutableConfigPermsMock).toHaveBeenCalledWith("alpha");
    expect(f.applyPresetMock).toHaveBeenCalledWith("alpha", "github", { nonFatal: true });
  });

  it("hardens an active timer window before force-deleting a restore destination", async () => {
    f.lifecycleMock.readTimerMarkerMock.mockReturnValue({
      pid: 4242,
      sandboxName: "beta",
      snapshotPath: "/tmp/policy.yaml",
      restoreAt: "2026-06-27T06:00:00.000Z",
      processToken: "b".repeat(32),
    });
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "openclaw",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          }
        : {
            name: "beta",
            agent: "openclaw",
            imageTag: "nemoclaw-beta:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          },
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", {
      kind: "restore",
      to: "beta",
      force: true,
      yes: true,
    });

    expect(f.shieldsMock.shieldsUpMock).toHaveBeenCalledWith("beta", {
      throwOnError: true,
      allowLegacyHermesProtocol: true,
    });
    expect(f.lifecycleMock.events).toEqual(
      expect.arrayContaining(["harden", "delete", "cleanup-shields"]),
    );
    expect(f.lifecycleMock.events.indexOf("harden")).toBeLessThan(
      f.lifecycleMock.events.indexOf("delete"),
    );
    expect(f.lifecycleMock.events.indexOf("delete")).toBeLessThan(
      f.lifecycleMock.events.indexOf("cleanup-shields"),
    );
    expect(f.streamSandboxCreateMock).toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("beta", "/tmp/backup-alpha");
  });

  it("blocks auto-create before deleting a destination when a gateway peer conflicts", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    f.getSandboxMock.mockImplementation((name) => ({
      name: name ?? "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      imageTag: `nemoclaw-${name}:test`,
      openshellDriver: "docker",
      provider: name === "gamma" ? "anthropic-prod" : "nvidia-nim",
      model: name === "gamma" ? "claude-new" : "nvidia/model-a",
    }));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(consoleError.mock.calls.flat().join("\n")).toContain("gamma");
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: true, expectedValue: "1" },
    { enabled: false, expectedValue: "0" },
  ])("starts a snapshot clone with the authoritative source observability state when enabled=$enabled", async ({
    enabled,
    expectedValue,
  }) => {
    let registeredClone: f.SandboxRecord | null = null;
    f.registerSandboxMock.mockImplementation(
      (entry) => (registeredClone = entry as f.SandboxRecord),
    );
    vi.stubEnv("NEMOCLAW_OBSERVABILITY", "1");
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "langchain-deepagents-code",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            observabilityEnabled: enabled,
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          }
        : registeredClone,
    );
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: dcodeProbeOutput("idle") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });
    const createCall = f.streamSandboxCreateMock.mock.calls[0] ?? [];
    const createArgs = createCall[1] as readonly string[];
    const createEnv = createCall[2] as NodeJS.ProcessEnv | undefined;
    expect(createCall[0]).toBe("openshell");
    expect(createArgs).toContain(`NEMOCLAW_OBSERVABILITY=${expectedValue}`);
    expect(createEnv?.NEMOCLAW_OBSERVABILITY).toBeUndefined();
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        observabilityEnabled: enabled,
      }),
    );
    expect(f.applyPresetMock).toHaveBeenCalledTimes(enabled ? 1 : 0);
    },
  );

  it("reserves an explicit llama.cpp clone with the original owner and exact gateway authority", async () => {
    const hostLocalInferenceReceipt = serializedLlamaCppHostLocalInferenceReceipt("docker");
    const hostLocalInferenceProvenance = createSandboxHostLocalInferenceProvenance(
      "alpha",
      hostLocalInferenceReceipt,
    );
    let registeredClone: f.SandboxRecord | null = null;
    f.registerSandboxMock.mockImplementation(
      (entry) => (registeredClone = entry as f.SandboxRecord),
    );
    const source: f.SandboxRecord = {
      name: "alpha",
      agent: "openclaw",
      imageTag: "nemoclaw-alpha:test",
      openshellDriver: "docker",
      provider: "llama-cpp-local",
      model: "nemotron-llama-cpp",
      endpointUrl: "https://inference.local/v1",
      endpointSource: "inference-set",
      credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
      preferredInferenceApi: "openai-completions",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "alpha-generation-1",
      hostLocalInferenceReceipt,
      hostLocalInferenceProvenance,
    };
    f.getSandboxMock.mockImplementation((name) => (name === "alpha" ? source : registeredClone));
    f.getLatestBackupMock.mockReturnValue({
      ...f.latestBackupFixture,
      agentType: "openclaw",
      hostLocalInferenceReceipt,
      hostLocalInferenceProvenance,
    });
    f.restoreSandboxStateMock.mockImplementation((_name, _path, options) => {
      options?.validateBeforeMutation?.();
      return {
        success: true,
        restoredDirs: [],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      };
    });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    const dependencies = await import("./snapshot/dependencies");
    const prepare = vi.spyOn(dependencies, "prepareHostLocalInferenceAuthority").mockImplementation(
      (_provider, candidate, serializedReceipt) =>
        ({
          providerId: "docker",
          sandboxName: candidate.name,
          serializedReceipt,
        }) as never,
    );
    const confirm = vi
      .spyOn(dependencies, "confirmHostLocalInferenceAuthority")
      .mockImplementation(() => undefined);
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    expect(f.reserveSandboxInferenceRouteMock).toHaveBeenCalledWith("beta", {
      provider: "llama-cpp-local",
      model: "nemotron-llama-cpp",
      endpointUrl: "https://inference.local/v1",
      endpointSource: "inference-set",
      credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
      preferredInferenceApi: "openai-completions",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      openshellDriver: "docker",
      hostLocalInferenceReceipt,
      hostLocalInferenceProvenance,
    });
    expect(registeredClone).toMatchObject({
      name: "beta",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      hostLocalInferenceReceipt,
      hostLocalInferenceProvenance,
    });
    expect(
      (registeredClone as f.SandboxRecord | null)?.hostLocalInferenceProvenance
        ?.runtimeOwnerSandboxName,
    ).toBe("alpha");
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "recorded", policyPresets: ["npm"] },
    { label: "legacy", policyPresets: undefined },
  ])("adds built-in OTLP egress for a $label snapshot", async ({ policyPresets }) => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      policyTier: "balanced",
    } as never);
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture, policyPresets });
    f.getAppliedPresetsMock.mockReturnValue(["npm"]);
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore" });
    expect(f.applyPresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local", {
      nonFatal: true,
    });
    expect(f.removePresetMock).not.toHaveBeenCalled();
  });

  it("removes historical built-in OTLP egress when observability was disabled after the snapshot", async () => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      ...f.latestBackupFixture,
      policyPresets: ["npm", "observability-otlp-local"],
    });
    f.getAppliedPresetsMock.mockReturnValue(["npm", "observability-otlp-local"]);
    f.getPresetContentGatewayStateMock.mockReturnValueOnce("match").mockReturnValueOnce("absent");
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local", {
      nonFatal: true,
    });
    expect(f.applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
  });

  it("removes an exact unrecorded built-in OTLP policy when observability is disabled", async () => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: [],
    } as never);
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture, policyPresets: [] });
    f.getAppliedPresetsMock.mockReturnValue([]);
    f.getPresetContentGatewayStateMock.mockReturnValueOnce("match").mockReturnValueOnce("absent");
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.getPresetContentGatewayStateMock).toHaveBeenCalledWith(
      "alpha",
      f.builtinObservabilityPolicy,
    );
    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local", {
      nonFatal: true,
    });
    expect(f.updateSandboxMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "returns false",
      configureRemoval: () => f.removePresetMock.mockReturnValue(false),
    },
    {
      label: "throws",
      configureRemoval: () =>
        f.removePresetMock.mockImplementation(() => {
          throw new Error("remove exploded");
        }),
    },
    {
      label: "claims success without removing",
      configureRemoval: () => f.removePresetMock.mockReturnValue(true),
    },
  ])("retains built-in OTLP attribution when removal $label", async ({ configureRemoval }) => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: [],
    } as never);
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture, policyPresets: [] });
    f.getAppliedPresetsMock.mockReturnValue([]);
    f.getPresetContentGatewayStateMock.mockReturnValue("match");
    configureRemoval();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local", {
      nonFatal: true,
    });
    expect(f.updateSandboxMock).toHaveBeenCalledWith("alpha", {
      policies: ["observability-otlp-local"],
    });
    expect(consoleWarn.mock.calls.flat().join("\n")).toContain(
      "exact content still live after remove",
    );
  });

  it("does not resurrect an earlier removed preset while restoring unverified OTLP attribution", async () => {
    let registryEntry = {
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: ["github", "observability-otlp-local"],
    };
    f.getSandboxMock.mockImplementation(() => registryEntry as never);
    f.updateSandboxMock.mockImplementation((_sandboxName, update) => {
      registryEntry = { ...registryEntry, ...(update as Partial<typeof registryEntry>) };
    });
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture, policyPresets: [] });
    f.getAppliedPresetsMock.mockReturnValue(["github", "observability-otlp-local"]);
    f.getPresetContentGatewayStateMock.mockReturnValue("match");
    f.removePresetMock
      .mockImplementationOnce((_sandboxName, presetName) => {
        expect(presetName).toBe("github");
        registryEntry = {
          ...registryEntry,
          policies: registryEntry.policies.filter((name) => name !== "github"),
        };
        return true;
      })
      .mockReturnValue(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.removePresetMock.mock.calls.map((call) => call[1])).toEqual([
      "github",
      "observability-otlp-local",
    ]);
    expect(f.updateSandboxMock).toHaveBeenLastCalledWith("alpha", {
      policies: ["observability-otlp-local"],
    });
    expect(registryEntry.policies).toEqual(["observability-otlp-local"]);
  });

  it.each([
    {
      label: "records an exact live enabled policy",
      observabilityEnabled: true,
      liveState: "match" as const,
      policies: ["npm"],
      expectedPolicies: ["npm", "observability-otlp-local"],
    },
    {
      label: "prunes an exact absent disabled policy",
      observabilityEnabled: false,
      liveState: "absent" as const,
      policies: ["npm", "observability-otlp-local"],
      expectedPolicies: ["npm"],
    },
  ])("repairs stale OTLP registry state: $label", async ({
    observabilityEnabled,
    liveState,
    policies: recordedPolicies,
    expectedPolicies,
  }) => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled,
      policyTier: "balanced",
      policies: recordedPolicies,
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      ...f.latestBackupFixture,
      policyPresets: ["npm"],
    });
    f.getAppliedPresetsMock.mockReturnValue(recordedPolicies);
    f.getPresetContentGatewayStateMock.mockReturnValue(liveState);
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.updateSandboxMock).toHaveBeenCalledWith("alpha", { policies: expectedPolicies });
    expect(f.applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(f.removePresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
  });

  it("does not let a same-name, different-key custom replay suppress stale built-in OTLP cleanup", async () => {
    const customPolicy = {
      name: "observability-otlp-local",
      content: "network_policies:\n  operator-collector: {}\n",
      sourcePath: "/policies/operator-collector.yaml",
    };
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      ...f.latestBackupFixture,
      policyPresets: [customPolicy.name],
      customPolicies: [customPolicy],
    });
    f.getCustomPoliciesMock.mockReturnValueOnce([]).mockReturnValue([customPolicy]);
    f.getAppliedPresetsMock.mockReturnValue(["observability-otlp-local"]);
    f.getPresetContentGatewayStateMock.mockReturnValueOnce("match").mockReturnValueOnce("absent");
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.applyPresetContentMock).toHaveBeenCalledWith(
      "alpha",
      customPolicy.name,
      customPolicy.content,
      { custom: { sourcePath: customPolicy.sourcePath }, nonFatal: true },
    );
    expect(f.removePresetMock).toHaveBeenCalledTimes(1);
    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local", {
      nonFatal: true,
    });
    expect(f.applyPresetMock).not.toHaveBeenCalledWith("alpha", customPolicy.name);
    expect(f.updateSandboxMock).not.toHaveBeenCalled();
  });

  it("lets successfully replayed corp-otel content own its exact live OTLP key", async () => {
    const customPolicy = {
      name: "corp-otel",
      content:
        "network_policies:\n  observability-otlp-local:\n    endpoints:\n      - host: collector.corp.example\n",
      sourcePath: "/policies/corp-otel.yaml",
    };
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: ["npm", "observability-otlp-local"],
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      ...f.latestBackupFixture,
      policyPresets: ["npm", "observability-otlp-local"],
      customPolicies: [customPolicy],
    });
    f.getCustomPoliciesMock.mockReturnValueOnce([]).mockReturnValue([customPolicy]);
    f.getAppliedPresetsMock.mockReturnValue(["npm", "corp-otel", "observability-otlp-local"]);
    f.getPresetContentGatewayStateMock.mockImplementation((_sandbox, content) =>
      content === customPolicy.content ? "match" : "drift",
    );
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.applyPresetContentMock).toHaveBeenCalledWith(
      "alpha",
      customPolicy.name,
      customPolicy.content,
      { custom: { sourcePath: customPolicy.sourcePath }, nonFatal: true },
    );
    expect(f.applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(f.removePresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(f.removePresetMock).not.toHaveBeenCalledWith("alpha", customPolicy.name);
    expect(f.updateSandboxMock).toHaveBeenCalledWith("alpha", { policies: ["npm"] });
    expect(f.getPresetContentGatewayStateMock).toHaveBeenCalledTimes(1);
    expect(f.getPresetContentGatewayStateMock.mock.calls[0]?.[1]).toBe(customPolicy.content);
    expect(f.getPresetContentGatewayStateMock.mock.calls[0]?.[2]).toBe("observability-otlp-local");
  });

  it("does not let a failed corp-otel replay suppress stale built-in OTLP cleanup", async () => {
    const customPolicy = {
      name: "corp-otel",
      content:
        "network_policies:\n  observability-otlp-local:\n    endpoints:\n      - host: collector.corp.example\n",
      sourcePath: "/policies/corp-otel.yaml",
    };
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: ["npm", "observability-otlp-local"],
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: ["npm", "observability-otlp-local"],
      customPolicies: [customPolicy],
    });
    f.getAppliedPresetsMock.mockReturnValue(["npm", "observability-otlp-local"]);
    f.applyPresetContentMock.mockReturnValue(false);
    f.getPresetContentGatewayStateMock.mockReturnValueOnce("match").mockReturnValueOnce("absent");
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(consoleWarn.mock.calls.flat().join("\n")).toContain("corp-otel (apply failed)");
    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local", {
      nonFatal: true,
    });
    expect(f.getPresetContentGatewayStateMock).toHaveBeenCalledTimes(2);
    expect(f.getPresetContentGatewayStateMock).toHaveBeenCalledWith(
      "alpha",
      f.builtinObservabilityPolicy,
    );
  });

  it("aborts preset reconciliation when custom OTLP ownership is unreadable", async () => {
    const currentCustomPolicy = {
      name: "corp-otel",
      content: "network_policies:\n  observability-otlp-local: {}\n",
      sourcePath: "/policies/old-collector.yaml",
    };
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      policyTier: "balanced",
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      ...f.latestBackupFixture,
      policyPresets: [],
      customPolicies: [],
    });
    f.getCustomPoliciesMock.mockReturnValue([currentCustomPolicy]);
    f.removePresetMock.mockReturnValue(false);
    f.getPresetContentGatewayStateMock.mockImplementation((_sandbox, content) =>
      content === currentCustomPolicy.content ? null : "absent",
    );
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore" });
    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", currentCustomPolicy.name, {
      nonFatal: true,
    });
    expect(f.applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(consoleWarn.mock.calls.flat().join("\n")).toContain(
      "leaving live policy presets unchanged",
    );
  });
  it.each([
    "drift",
    null,
  ] as const)("does not remove built-in OTLP when its exact live content state is %s", async (gatewayState) => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      ...f.latestBackupFixture,
      policyPresets: ["observability-otlp-local"],
    });
    f.getAppliedPresetsMock.mockReturnValue(["observability-otlp-local"]);
    f.getPresetContentGatewayStateMock.mockReturnValue(gatewayState);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.removePresetMock).not.toHaveBeenCalled();
    expect(consoleWarn.mock.calls.flat().join("\n")).toContain(
      "leaving its live policy content unchanged",
    );
  });

  it("normalizes a legacy restricted tier before deciding built-in OTLP egress", async () => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      policyTier: " Restricted ",
    } as never);
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture, policyPresets: [] });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
  });

  it("refuses snapshot creation before backup when the sandbox is not live", async () => {
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["beta"]));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Sandbox 'alpha' is not running. Cannot create snapshot.",
    );
  });

  it("prints backup error details when snapshot creation fails with an error", async () => {
    f.backupSandboxStateMock.mockReturnValue({
      success: false,
      error: "tar exploded",
      failedDirs: [],
      failedFiles: [],
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");
    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(f.backupSandboxStateMock).toHaveBeenCalledWith("alpha", {
      name: null,
    });
    expect(consoleError.mock.calls.flat().join("\n")).toContain("tar exploded");
  });

  it("reconciles snapshot policies after restore and warns without failing on repair misses", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.getLatestBackupMock.mockReturnValue({
      backupPath: "/tmp/alpha/v2",
      timestamp: "2026-06-02T00:00:00.000Z",
      policyPresets: ["npm", "github"],
      customPolicies: [
        {
          name: "team-egress",
          content: "network_policies:\n  team-egress: {}\n",
          sourcePath: "/policies/team.yaml",
        },
      ],
    });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
    });
    f.getAppliedPresetsMock.mockReturnValue(["npm", "team-egress", "old-preset"]);
    f.getCustomPoliciesMock.mockReturnValue([
      {
        name: "team-egress",
        content: "network_policies:\n  team-egress: {}\n",
        sourcePath: "/policies/team.yaml",
      },
      { name: "old-custom", content: "network_policies:\n  old: {}\n", sourcePath: "/old.yaml" },
    ]);
    f.removePresetMock.mockImplementation((_sandbox, preset) => preset !== "old-custom");
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/alpha/v2");
    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", "old-preset", { nonFatal: true });
    expect(f.applyPresetMock).toHaveBeenCalledWith("alpha", "github", { nonFatal: true });
    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", "old-custom", { nonFatal: true });
    expect(f.removePresetMock).not.toHaveBeenCalledWith("alpha", "team-egress");
    expect(f.applyPresetContentMock).not.toHaveBeenCalled();
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("✓ Restored 1 directories, 1 files");
    expect(output).toContain(
      "Reconciling policy presets on 'alpha': add github; remove old-preset",
    );
    expect(output).toContain("Reconciling custom policies on 'alpha': remove old-custom");
    expect(consoleWarn.mock.calls.flat().join("\n")).toContain(
      "Warning: could not reconcile custom policy(ies): old-custom (remove failed)",
    );
  });
});
