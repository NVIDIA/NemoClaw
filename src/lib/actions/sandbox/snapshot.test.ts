// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_EXEC_STARTED_MARKER } from "./sandbox-exec-output";

type OpenshellCaptureResult = {
  status: number | null;
  output: string;
  stdout?: string;
  stderr?: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
};
type SandboxRecord = {
  name: string;
  agent?: string | null;
  gatewayName?: string | null;
  imageTag?: string | null;
  openshellDriver?: string | null;
};
type DcodeProbeState = "active" | "idle" | "unverifiable" | "no-runtime";

function dcodeProbeOutput(state: DcodeProbeState, extra = ""): string {
  return `${SANDBOX_EXEC_STARTED_MARKER}\nNEMOCLAW_DCODE_PROBE=${state}\n${extra}`;
}

function framedDcodeProbeOutput(state: DcodeProbeState, framePrefix = "stdout: "): string {
  return `${framePrefix}${SANDBOX_EXEC_STARTED_MARKER}\n${framePrefix}NEMOCLAW_DCODE_PROBE=${state}\n`;
}

function captureOpenshellStreams(
  args: string[],
  result: OpenshellCaptureResult,
): OpenshellCaptureResult {
  const command = String(args.at(-1) ?? "");
  const marker = command.match(/printf '%s\\n' '([^']+)'/)?.[1] ?? SANDBOX_EXEC_STARTED_MARKER;
  const replaceMarker = (value: string) => value.replaceAll(SANDBOX_EXEC_STARTED_MARKER, marker);
  const stdout = replaceMarker(result.stdout ?? result.output);
  const stderr = replaceMarker(result.stderr ?? "");
  return { ...result, output: stdout, stdout, stderr };
}

function openshellResponses(
  args: string[],
  responses: Record<string, OpenshellCaptureResult>,
): OpenshellCaptureResult {
  const result = responses[`${args[0] ?? ""} ${args[1] ?? ""}`] ?? {
    status: 0,
    output: "",
  };
  return captureOpenshellStreams(args, result);
}

function defaultOpenshellResponses(args: string[]): OpenshellCaptureResult {
  return openshellResponses(args, {
    "sandbox exec": { status: 0, output: dcodeProbeOutput("no-runtime") },
    "sandbox list": {
      status: 0,
      output: "alpha Ready\n",
    },
  });
}

const shieldsMock = vi.hoisted(() => {
  const isShieldsDownMock = vi.fn(() => true);
  const repairMutableConfigPermsMock = vi.fn(() => ({
    applied: true,
    verified: true,
    errors: [],
  }));
  const shieldsUpMock = vi.fn();
  let isShieldsDownExport: unknown = isShieldsDownMock;
  return {
    isShieldsDownMock,
    repairMutableConfigPermsMock,
    shieldsUpMock,
    getIsShieldsDownExport: () => isShieldsDownExport,
    setIsShieldsDownExport: (value: unknown) => {
      isShieldsDownExport = value;
    },
  };
});

const lifecycleMock = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    cleanupShieldsDestroyArtifactsMock: vi.fn(() => events.push("cleanup-shields")),
    readTimerMarkerMock: vi.fn(() => null as Record<string, unknown> | null),
    withTimerBoundMock: vi.fn(
      (_sandboxName: string, command: string, fn: () => unknown): unknown => {
        events.push(`lock:${command}`);
        return fn();
      },
    ),
  };
});

const backupSandboxStateMock = vi.fn();
const captureOpenshellMock = vi.fn<
  (args: string[], opts?: Record<string, unknown>) => OpenshellCaptureResult
>((args) => defaultOpenshellResponses(args));
const dockerInspectMock = vi.fn(() => ({ status: 0, stdout: "true\n" }));
const findBackupMock = vi.fn();
const getAppliedPresetsMock = vi.fn(() => [] as string[]);
const getCustomPoliciesMock = vi.fn(
  () => [] as Array<{ name: string; content: string; sourcePath?: string }>,
);
const getLatestBackupMock = vi.fn(() => null as Record<string, unknown> | null);
const applyPresetMock = vi.fn((_sandbox: string, _preset: string) => true);
const applyPresetContentMock = vi.fn(
  (_sandbox: string, _name: string, _content: string, _options?: unknown) => true,
);
const removePresetMock = vi.fn((_sandbox: string, _preset: string) => true);
const getSandboxMock = vi.fn<(name?: string) => SandboxRecord | null>(() => null);
const isGatewayHealthyMock = vi.fn(() => true);
const listBackupsMock = vi.fn<() => Array<Record<string, unknown>>>(() => []);
const parseLiveSandboxNamesMock = vi.fn(() => new Set(["alpha"]));
const registerSandboxMock = vi.fn();
const restoreSandboxStateMock = vi.fn();
const runOpenshellMock = vi.fn((args: string[]) => {
  args[0] === "sandbox" && args[1] === "delete" && lifecycleMock.events.push("delete");
  return { status: 0, output: "" };
});
const streamSandboxCreateMock = vi.fn(async () => ({
  status: 0,
  output: "",
  forcedReady: false,
}));
const dcodeSandboxEntry = {
  name: "alpha",
  agent: "langchain-deepagents-code",
};

vi.mock("../../adapters/docker", () => ({
  dockerCapture: vi.fn(() => ""),
  dockerInspect: dockerInspectMock,
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: captureOpenshellMock,
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: runOpenshellMock,
}));

vi.mock("../../credentials/store", () => ({
  prompt: vi.fn(),
}));

vi.mock("../../domain/sandbox/destroy", () => ({
  getSandboxDeleteOutcome: vi.fn(() => ({ alreadyGone: false, gatewayUnreachable: false })),
}));

vi.mock("../../inference/nim", () => ({
  stopNimContainer: vi.fn(),
  stopNimContainerByName: vi.fn(),
}));

vi.mock("../../policy", () => ({
  applyPreset: applyPresetMock,
  applyPresetContent: applyPresetContentMock,
  getAppliedPresets: getAppliedPresetsMock,
  removePreset: removePresetMock,
}));

vi.mock("../../runner", () => ({
  ROOT: "/repo",
  run: vi.fn(() => ({ status: 0 })),
  shellQuote: (value: string) => `'${value}'`,
  validateName: vi.fn((value: string) => value),
}));

vi.mock("../../runtime-recovery", () => ({
  parseLiveSandboxNames: parseLiveSandboxNamesMock,
}));

vi.mock("../../shields", () => ({
  get isShieldsDown() {
    return shieldsMock.getIsShieldsDownExport();
  },
  repairMutableConfigPerms: shieldsMock.repairMutableConfigPermsMock,
  shieldsUp: shieldsMock.shieldsUpMock,
}));

vi.mock("../../shields/timer-bound-lock", () => ({
  withTimerBoundShieldsMutationLock: lifecycleMock.withTimerBoundMock,
}));

vi.mock("../../shields/timer-control", () => ({
  readTimerMarker: lifecycleMock.readTimerMarkerMock,
}));

vi.mock("../../sandbox/create-stream", () => ({
  streamSandboxCreate: streamSandboxCreateMock,
}));

vi.mock("../../state/gateway", () => ({
  isGatewayHealthy: isGatewayHealthyMock,
  isSandboxReady: vi.fn((output: string, sandboxName: string) =>
    output.includes(`${sandboxName} Ready`),
  ),
}));

vi.mock("../../state/registry", () => ({
  getCustomPolicies: getCustomPoliciesMock,
  getSandbox: getSandboxMock,
  registerSandbox: registerSandboxMock,
  removeSandbox: vi.fn(),
}));

vi.mock("../../state/sandbox", () => ({
  backupSandboxState: backupSandboxStateMock,
  findBackup: findBackupMock,
  getLatestBackup: getLatestBackupMock,
  listBackups: listBackupsMock,
  restoreSandboxState: restoreSandboxStateMock,
}));

vi.mock("./destroy", () => ({
  cleanupShieldsDestroyArtifacts: lifecycleMock.cleanupShieldsDestroyArtifactsMock,
  removeSandboxRegistryEntry: vi.fn(),
}));

describe("runSandboxSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shieldsMock.setIsShieldsDownExport(shieldsMock.isShieldsDownMock);
    shieldsMock.isShieldsDownMock.mockReturnValue(true);
    shieldsMock.shieldsUpMock.mockImplementation(() => lifecycleMock.events.push("harden"));
    lifecycleMock.events.length = 0;
    lifecycleMock.readTimerMarkerMock.mockReturnValue(null);
    captureOpenshellMock.mockImplementation((args) => defaultOpenshellResponses(args));
    dockerInspectMock.mockReturnValue({ status: 0, stdout: "true\n" });
    findBackupMock.mockReturnValue({ match: null });
    getAppliedPresetsMock.mockReturnValue([]);
    getCustomPoliciesMock.mockReturnValue([]);
    getLatestBackupMock.mockReturnValue(null);
    applyPresetMock.mockReturnValue(true);
    applyPresetContentMock.mockReturnValue(true);
    removePresetMock.mockReturnValue(true);
    getSandboxMock.mockReturnValue(null);
    isGatewayHealthyMock.mockReturnValue(true);
    listBackupsMock.mockReturnValue([]);
    registerSandboxMock.mockReset();
    restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: [],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockDcodeProbe(state: DcodeProbeState, output = "") {
    mockDcodeProbeResult({ status: 0, output: dcodeProbeOutput(state, output) });
  }

  function mockDcodeProbeResult(result: OpenshellCaptureResult) {
    captureOpenshellMock.mockImplementation((args: string[]) => {
      return openshellResponses(args, {
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
      captureOpenshellMock.mock.calls
        .map(([args]) => args)
        .find((args) => args[0] === "sandbox" && args[1] === "exec") ?? [];
    return String(execArgs.at(-1) ?? "");
  }

  function runProbeScriptWithProcesses(
    script: string,
    processes: string,
  ): { status: number; output: string } {
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
    shieldsMock.setIsShieldsDownExport(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
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
    backupSandboxStateMock.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      backedUpFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
      manifest,
    });
    findBackupMock.mockReturnValue({
      match: { ...manifest, snapshotVersion: 7, name: "before-upgrade" },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", {
      kind: "create",
      name: "before-upgrade",
    });

    expect(backupSandboxStateMock).toHaveBeenCalledWith("alpha", {
      name: "before-upgrade",
    });
    expect(findBackupMock).toHaveBeenCalledWith("alpha", manifest.timestamp);
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Creating snapshot of 'alpha' (--name before-upgrade)");
    expect(output).toContain("Snapshot v7 name=before-upgrade created");
    expect(output).toContain("/tmp/backup-alpha");
  });

  it("refuses snapshot creation before backup when a dcode task is active", async () => {
    getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbe("active", "123 python3 -m deepagents_code -n write a script\n");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
    expect(
      captureOpenshellMock.mock.calls.some(
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

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Sandbox is actively running a dcode task. Please retry after the task completes.",
    );
  });

  it("allows dcode snapshot creation when the process probe finds no active task", async () => {
    getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbe("idle");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const manifest = {
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      name: "idle",
    };
    backupSandboxStateMock.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      backedUpFiles: ["config.toml"],
      failedDirs: [],
      failedFiles: [],
      manifest,
    });
    findBackupMock.mockReturnValue({
      match: { ...manifest, snapshotVersion: 8, name: "idle" },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "create", name: "idle" });

    expect(backupSandboxStateMock).toHaveBeenCalledWith("alpha", {
      name: "idle",
    });
    expect(consoleLog.mock.calls.flat().join("\n")).toContain("Snapshot v8 name=idle created");
  });

  it("allows dcode snapshot creation when OpenShell frames the probe stdout", async () => {
    getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbeResult({ status: 0, output: framedDcodeProbeOutput("idle") });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const manifest = {
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      name: "framed-idle",
    };
    backupSandboxStateMock.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      backedUpFiles: ["config.toml"],
      failedDirs: [],
      failedFiles: [],
      manifest,
    });
    findBackupMock.mockReturnValue({
      match: { ...manifest, snapshotVersion: 9, name: "framed-idle" },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "create", name: "framed-idle" });

    expect(backupSandboxStateMock).toHaveBeenCalledWith("alpha", { name: "framed-idle" });
    expect(consoleLog.mock.calls.flat().join("\n")).toContain(
      "Snapshot v9 name=framed-idle created",
    );
    const execCall = captureOpenshellMock.mock.calls.find(
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
    getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbeResult({ status: 0, output: framedDcodeProbeOutput("active", "[stdout] ") });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Sandbox is actively running a dcode task. Please retry after the task completes.",
    );
  });

  it("refuses a probe that repeats its marker after an active state", async () => {
    getSandboxMock.mockReturnValue(dcodeSandboxEntry);
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

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task.",
    );
  });

  it("refuses conflicting probe states after one valid marker", async () => {
    getSandboxMock.mockReturnValue(dcodeSandboxEntry);
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

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task.",
    );
  });

  it("refuses conflicting probe markers split across stdout and stderr", async () => {
    getSandboxMock.mockReturnValue(dcodeSandboxEntry);
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

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task.",
    );
  });

  it("refuses an idle dcode snapshot when the exec wrapper reports a non-zero status", async () => {
    getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbeResult({ status: 1, output: dcodeProbeOutput("idle") });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task. Refusing to create snapshot.",
    );
  });

  it("refuses registered dcode snapshots when raw status 1 has no idle sentinel", async () => {
    getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbeResult({ status: 1, output: "exec failed" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task. Refusing to create snapshot.",
    );
  });

  it("refuses registered dcode snapshots when the probe times out", async () => {
    getSandboxMock.mockReturnValue(dcodeSandboxEntry);
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

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task. Refusing to create snapshot.",
    );
  });

  it("refuses dcode snapshot creation before backup when task state cannot be verified", async () => {
    getSandboxMock.mockReturnValue(dcodeSandboxEntry);
    mockDcodeProbe("unverifiable", "ps: command failed\n");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
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

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify whether sandbox 'alpha' is actively running a dcode task. Refusing to create snapshot.",
    );
  });

  it("keeps registered non-dcode snapshots on the existing path when the dcode probe fails", async () => {
    getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });
    mockDcodeProbeResult({ status: 1, output: "exec unsupported" });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const manifest = {
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
    };
    backupSandboxStateMock.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      backedUpFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
      manifest,
    });
    findBackupMock.mockReturnValue({
      match: { ...manifest, snapshotVersion: 3 },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "create" });

    expect(
      captureOpenshellMock.mock.calls.some(([args]) => args[0] === "sandbox" && args[1] === "exec"),
    ).toBe(false);
    expect(backupSandboxStateMock).toHaveBeenCalledWith("alpha", {
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
    backupSandboxStateMock.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      backedUpFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
      manifest,
    });
    findBackupMock.mockReturnValue({
      match: { ...manifest, snapshotVersion: 3 },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "create" });

    const probeScript = capturedDcodeProbeScript();
    const shellCommandLine = probeScript.replace(/\s+/g, " ");
    for (const processLine of [
      "123 python3 -m deepagents_code --sandbox none --no-mcp -n work\n",
      "123 /opt/venv/bin/python3 -m deepagents_code --sandbox none --no-mcp -n work\n",
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
    listBackupsMock.mockReturnValue([
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

  it("restores the latest snapshot into the source sandbox", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    getLatestBackupMock.mockReturnValue({
      snapshotVersion: 4,
      name: "stable",
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
    });
    restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Using latest snapshot v4 name=stable");
    expect(output).toContain("Restoring snapshot into 'alpha'");
    expect(output).toContain("Restored 1 directories, 1 files");
  });

  it("keeps active-timer restore, permission repair, and policy reconciliation serialized", async () => {
    lifecycleMock.readTimerMarkerMock.mockReturnValue({
      pid: 4242,
      sandboxName: "alpha",
      snapshotPath: "/tmp/policy.yaml",
      restoreAt: "2026-06-27T06:00:00.000Z",
      processToken: "a".repeat(32),
    });
    getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: ["github"],
    });
    restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(lifecycleMock.events).toContain("lock:restore sandbox snapshot");
    expect(restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");
    expect(shieldsMock.repairMutableConfigPermsMock).toHaveBeenCalledWith("alpha");
    expect(applyPresetMock).toHaveBeenCalledWith("alpha", "github");
  });

  it("hardens an active timer window before force-deleting a restore destination", async () => {
    lifecycleMock.readTimerMarkerMock.mockReturnValue({
      pid: 4242,
      sandboxName: "beta",
      snapshotPath: "/tmp/policy.yaml",
      restoreAt: "2026-06-27T06:00:00.000Z",
      processToken: "b".repeat(32),
    });
    getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "openclaw",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
          }
        : {
            name: "beta",
            agent: "openclaw",
            imageTag: "nemoclaw-beta:test",
            openshellDriver: "docker",
          },
    );
    parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    captureOpenshellMock.mockImplementation((args) =>
      openshellResponses(args, {
        "sandbox exec": { status: 0, output: dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
    });
    restoreSandboxStateMock.mockReturnValue({
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

    expect(shieldsMock.shieldsUpMock).toHaveBeenCalledWith("beta", {
      throwOnError: true,
      allowLegacyHermesProtocol: true,
    });
    expect(lifecycleMock.events.indexOf("harden")).toBeLessThan(
      lifecycleMock.events.indexOf("delete"),
    );
    expect(lifecycleMock.events.indexOf("delete")).toBeLessThan(
      lifecycleMock.events.indexOf("cleanup-shields"),
    );
    expect(streamSandboxCreateMock).toHaveBeenCalled();
    expect(restoreSandboxStateMock).toHaveBeenCalledWith("beta", "/tmp/backup-alpha");
  });

  it("refuses snapshot creation before backup when the sandbox is not live", async () => {
    parseLiveSandboxNamesMock.mockReturnValue(new Set(["beta"]));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Sandbox 'alpha' is not running. Cannot create snapshot.",
    );
  });

  it("prints backup error details when snapshot creation fails with an error", async () => {
    backupSandboxStateMock.mockReturnValue({
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

    expect(backupSandboxStateMock).toHaveBeenCalledWith("alpha", {
      name: null,
    });
    expect(consoleError.mock.calls.flat().join("\n")).toContain("tar exploded");
  });

  it("reconciles snapshot policies after restore and warns without failing on repair misses", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getLatestBackupMock.mockReturnValue({
      backupPath: "/tmp/alpha/v2",
      timestamp: "2026-06-02T00:00:00.000Z",
      policyPresets: ["npm", "github"],
      customPolicies: [
        {
          name: "team-egress",
          content: "allow team.example",
          sourcePath: "/policies/team.yaml",
        },
      ],
    });
    restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
    });
    getAppliedPresetsMock.mockReturnValue(["npm", "team-egress", "old-preset"]);
    getCustomPoliciesMock.mockReturnValue([
      {
        name: "team-egress",
        content: "allow team.example",
        sourcePath: "/policies/team.yaml",
      },
      { name: "old-custom", content: "allow old.example", sourcePath: "/old.yaml" },
    ]);
    removePresetMock.mockImplementation((_sandbox, preset) => preset !== "old-custom");
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/alpha/v2");
    expect(removePresetMock).toHaveBeenCalledWith("alpha", "old-preset");
    expect(applyPresetMock).toHaveBeenCalledWith("alpha", "github");
    expect(removePresetMock).toHaveBeenCalledWith("alpha", "old-custom");
    expect(removePresetMock).not.toHaveBeenCalledWith("alpha", "team-egress");
    expect(applyPresetContentMock).not.toHaveBeenCalled();
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

  it("prints failed dirs and files when snapshot creation fails without an error", async () => {
    backupSandboxStateMock.mockReturnValue({
      success: false,
      failedDirs: ["workspace", "skills"],
      failedFiles: ["openclaw.json"],
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    const errors = consoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("Snapshot failed.");
    expect(errors).toContain("Failed directories: workspace, skills");
    expect(errors).toContain("Failed files: openclaw.json");
  });
});
