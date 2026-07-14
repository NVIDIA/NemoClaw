// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_EXEC_STARTED_MARKER } from "./sandbox-exec-output";
import type { SnapshotStreamSandboxCreateMock } from "./snapshot-create-stream-test-types";

type OpenshellCaptureResult = {
  status: number | null;
  output: string;
  stdout?: string;
  stderr?: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
};
type SandboxRecord = { name: string; observabilityEnabled?: boolean } & Record<string, unknown>;
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
const getPresetContentGatewayStateMock = vi.fn<
  (_sandbox: string, _content: string, _policyKey?: string) => "match" | "absent" | "drift" | null
>(() => "absent");
const builtinObservabilityPolicy =
  "network_policies:\n  observability-otlp-local:\n    endpoints:\n      - host: host.openshell.internal\n";
const loadPresetForSandboxMock = vi.fn((_sandbox: string, preset: string) =>
  preset === "observability-otlp-local" ? builtinObservabilityPolicy : null,
);
const getSandboxMock = vi.fn<(name?: string) => SandboxRecord | null>(() => null);
const isGatewayHealthyMock = vi.fn(() => true);
const listBackupsMock = vi.fn<() => Array<Record<string, unknown>>>(() => []);
const parseLiveSandboxNamesMock = vi.fn(() => new Set(["alpha"]));
const registerSandboxMock = vi.fn();
const updateSandboxMock = vi.fn();
const restoreSandboxStateMock = vi.fn();
const runOpenshellMock = vi.fn((args: string[]) => {
  args[0] === "sandbox" && args[1] === "delete" && lifecycleMock.events.push("delete");
  return { status: 0, output: "" };
});
const streamSandboxCreateMock = vi.fn<SnapshotStreamSandboxCreateMock>(async () => ({
  status: 0,
  output: "",
  sawProgress: false,
  forcedReady: false,
}));
const dcodeSandboxEntry = {
  name: "alpha",
  agent: "langchain-deepagents-code",
};
const latestBackupFixture = {
  timestamp: "2026-06-15T00:00:00.000Z",
  backupPath: "/tmp/backup-alpha",
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
  getPresetContentGatewayState: getPresetContentGatewayStateMock,
  loadPresetForSandbox: loadPresetForSandboxMock,
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
  listSandboxes: () => ({
    sandboxes: ["alpha", "beta", "gamma"].map((name) => getSandboxMock(name)).filter(Boolean),
    defaultSandbox: "alpha",
  }),
  registerSandbox: registerSandboxMock,
  removeSandbox: vi.fn(),
  updateSandbox: updateSandboxMock,
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
    getPresetContentGatewayStateMock.mockReturnValue("absent");
    loadPresetForSandboxMock.mockImplementation((_sandbox, preset) =>
      preset === "observability-otlp-local" ? builtinObservabilityPolicy : null,
    );
    getSandboxMock.mockReturnValue(null);
    isGatewayHealthyMock.mockReturnValue(true);
    listBackupsMock.mockReturnValue([]);
    registerSandboxMock.mockReset();
    updateSandboxMock.mockReset();
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
    vi.unstubAllEnvs();
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
    parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    captureOpenshellMock.mockImplementation((args) =>
      openshellResponses(args, {
        "sandbox exec": { status: 0, output: dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    getLatestBackupMock.mockReturnValue({ ...latestBackupFixture });
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

  it("blocks auto-create before deleting a destination when a gateway peer conflicts", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    getSandboxMock.mockImplementation((name) => ({
      name: name ?? "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      imageTag: `nemoclaw-${name}:test`,
      openshellDriver: "docker",
      provider: name === "gamma" ? "anthropic-prod" : "nvidia-nim",
      model: name === "gamma" ? "claude-new" : "nvidia/model-a",
    }));
    parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    captureOpenshellMock.mockImplementation((args) =>
      openshellResponses(args, {
        "sandbox exec": { status: 0, output: dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    getLatestBackupMock.mockReturnValue({ ...latestBackupFixture });
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
    expect(lifecycleMock.events).not.toContain("delete");
    expect(streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(registerSandboxMock).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: true, expectedValue: "1" },
    { enabled: false, expectedValue: "0" },
  ])("starts a snapshot clone with the authoritative source observability state when enabled=$enabled", async ({
    enabled,
    expectedValue,
  }) => {
    let registeredClone: SandboxRecord | null = null;
    registerSandboxMock.mockImplementation((entry) => (registeredClone = entry as SandboxRecord));
    vi.stubEnv("NEMOCLAW_OBSERVABILITY", "1");
    getSandboxMock.mockImplementation((name) =>
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
    captureOpenshellMock.mockImplementation((args) =>
      openshellResponses(args, {
        "sandbox exec": { status: 0, output: dcodeProbeOutput("idle") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    getLatestBackupMock.mockReturnValue({ ...latestBackupFixture });
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });
    const createCall = streamSandboxCreateMock.mock.calls[0] ?? [];
    const createArgs = createCall[1] as readonly string[];
    const createEnv = createCall[2] as NodeJS.ProcessEnv | undefined;
    expect(createCall[0]).toBe("openshell");
    expect(createArgs).toContain(`NEMOCLAW_OBSERVABILITY=${expectedValue}`);
    expect(createEnv?.NEMOCLAW_OBSERVABILITY).toBeUndefined();
    expect(registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        observabilityEnabled: enabled,
      }),
    );
    expect(applyPresetMock).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });

  it.each([
    { label: "recorded", policyPresets: ["npm"] },
    { label: "legacy", policyPresets: undefined },
  ])("adds built-in OTLP egress for a $label snapshot", async ({ policyPresets }) => {
    getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      policyTier: "balanced",
    } as never);
    getLatestBackupMock.mockReturnValue({ ...latestBackupFixture, policyPresets });
    getAppliedPresetsMock.mockReturnValue(["npm"]);
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore" });
    expect(applyPresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(removePresetMock).not.toHaveBeenCalled();
  });

  it("removes historical built-in OTLP egress when observability was disabled after the snapshot", async () => {
    getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
    } as never);
    getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: ["npm", "observability-otlp-local"],
    });
    getAppliedPresetsMock.mockReturnValue(["npm", "observability-otlp-local"]);
    getPresetContentGatewayStateMock.mockReturnValueOnce("match").mockReturnValueOnce("absent");
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
  });

  it("removes an exact unrecorded built-in OTLP policy when observability is disabled", async () => {
    getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: [],
    } as never);
    getLatestBackupMock.mockReturnValue({ ...latestBackupFixture, policyPresets: [] });
    getAppliedPresetsMock.mockReturnValue([]);
    getPresetContentGatewayStateMock.mockReturnValueOnce("match").mockReturnValueOnce("absent");
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(getPresetContentGatewayStateMock).toHaveBeenCalledWith(
      "alpha",
      builtinObservabilityPolicy,
    );
    expect(removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(updateSandboxMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "returns false",
      configureRemoval: () => removePresetMock.mockReturnValue(false),
    },
    {
      label: "throws",
      configureRemoval: () =>
        removePresetMock.mockImplementation(() => {
          throw new Error("remove exploded");
        }),
    },
    {
      label: "claims success without removing",
      configureRemoval: () => removePresetMock.mockReturnValue(true),
    },
  ])("retains built-in OTLP attribution when removal $label", async ({ configureRemoval }) => {
    getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: [],
    } as never);
    getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: [],
    });
    getAppliedPresetsMock.mockReturnValue([]);
    getPresetContentGatewayStateMock.mockReturnValue("match");
    configureRemoval();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(getPresetContentGatewayStateMock).toHaveBeenCalledTimes(2);
    expect(updateSandboxMock).toHaveBeenCalledWith("alpha", {
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
    getSandboxMock.mockImplementation(() => registryEntry as never);
    updateSandboxMock.mockImplementation((_sandboxName, update) => {
      registryEntry = { ...registryEntry, ...(update as Partial<typeof registryEntry>) };
    });
    getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: [],
    });
    getAppliedPresetsMock.mockReturnValue(["github", "observability-otlp-local"]);
    getPresetContentGatewayStateMock.mockReturnValue("match");
    removePresetMock
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

    expect(removePresetMock.mock.calls.map((call) => call[1])).toEqual([
      "github",
      "observability-otlp-local",
    ]);
    expect(updateSandboxMock).toHaveBeenLastCalledWith("alpha", {
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
    getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled,
      policyTier: "balanced",
      policies: recordedPolicies,
    } as never);
    getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: ["npm"],
    });
    getAppliedPresetsMock.mockReturnValue(recordedPolicies);
    getPresetContentGatewayStateMock.mockReturnValue(liveState);
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(updateSandboxMock).toHaveBeenCalledWith("alpha", { policies: expectedPolicies });
    expect(applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(removePresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
  });

  it("does not let a same-name, different-key custom replay suppress stale built-in OTLP cleanup", async () => {
    const customPolicy = {
      name: "observability-otlp-local",
      content: "network_policies:\n  operator-collector: {}\n",
      sourcePath: "/policies/operator-collector.yaml",
    };
    getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
    } as never);
    getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: [customPolicy.name],
      customPolicies: [customPolicy],
    });
    getCustomPoliciesMock.mockReturnValueOnce([]).mockReturnValue([customPolicy]);
    getAppliedPresetsMock.mockReturnValue(["observability-otlp-local"]);
    getPresetContentGatewayStateMock.mockReturnValueOnce("match").mockReturnValueOnce("absent");
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(applyPresetContentMock).toHaveBeenCalledWith(
      "alpha",
      customPolicy.name,
      customPolicy.content,
      { custom: { sourcePath: customPolicy.sourcePath } },
    );
    expect(removePresetMock).toHaveBeenCalledTimes(1);
    expect(removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(applyPresetMock).not.toHaveBeenCalledWith("alpha", customPolicy.name);
    expect(updateSandboxMock).not.toHaveBeenCalled();
  });

  it("lets successfully replayed corp-otel content own its exact live OTLP key", async () => {
    const customPolicy = {
      name: "corp-otel",
      content:
        "network_policies:\n  observability-otlp-local:\n    endpoints:\n      - host: collector.corp.example\n",
      sourcePath: "/policies/corp-otel.yaml",
    };
    getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: ["npm", "observability-otlp-local"],
    } as never);
    getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: ["npm", "observability-otlp-local"],
      customPolicies: [customPolicy],
    });
    getCustomPoliciesMock.mockReturnValueOnce([]).mockReturnValue([customPolicy]);
    getAppliedPresetsMock.mockReturnValue(["npm", "corp-otel", "observability-otlp-local"]);
    getPresetContentGatewayStateMock.mockImplementation((_sandbox, content) =>
      content === customPolicy.content ? "match" : "drift",
    );
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(applyPresetContentMock).toHaveBeenCalledWith(
      "alpha",
      customPolicy.name,
      customPolicy.content,
      { custom: { sourcePath: customPolicy.sourcePath } },
    );
    expect(applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(removePresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(removePresetMock).not.toHaveBeenCalledWith("alpha", customPolicy.name);
    expect(updateSandboxMock).toHaveBeenCalledWith("alpha", { policies: ["npm"] });
    expect(getPresetContentGatewayStateMock).toHaveBeenCalledTimes(1);
    expect(getPresetContentGatewayStateMock.mock.calls[0]?.[1]).toBe(customPolicy.content);
    expect(getPresetContentGatewayStateMock.mock.calls[0]?.[2]).toBe("observability-otlp-local");
  });

  it("does not let a failed corp-otel replay suppress stale built-in OTLP cleanup", async () => {
    const customPolicy = {
      name: "corp-otel",
      content:
        "network_policies:\n  observability-otlp-local:\n    endpoints:\n      - host: collector.corp.example\n",
      sourcePath: "/policies/corp-otel.yaml",
    };
    getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: ["npm", "observability-otlp-local"],
    } as never);
    getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: ["npm", "observability-otlp-local"],
      customPolicies: [customPolicy],
    });
    getAppliedPresetsMock.mockReturnValue(["npm", "observability-otlp-local"]);
    applyPresetContentMock.mockReturnValue(false);
    getPresetContentGatewayStateMock.mockReturnValueOnce("match").mockReturnValueOnce("absent");
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(consoleWarn.mock.calls.flat().join("\n")).toContain("corp-otel (apply failed)");
    expect(removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(getPresetContentGatewayStateMock).toHaveBeenCalledTimes(2);
    expect(getPresetContentGatewayStateMock).toHaveBeenCalledWith(
      "alpha",
      builtinObservabilityPolicy,
    );
  });

  it("aborts preset reconciliation when custom OTLP ownership is unreadable", async () => {
    const currentCustomPolicy = {
      name: "corp-otel",
      content: "network_policies:\n  observability-otlp-local: {}\n",
      sourcePath: "/policies/old-collector.yaml",
    };
    getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      policyTier: "balanced",
    } as never);
    getLatestBackupMock.mockReturnValue({
      ...latestBackupFixture,
      policyPresets: [],
      customPolicies: [],
    });
    getCustomPoliciesMock.mockReturnValue([currentCustomPolicy]);
    removePresetMock.mockReturnValue(false);
    getPresetContentGatewayStateMock.mockImplementation((_sandbox, content) =>
      content === currentCustomPolicy.content ? null : "absent",
    );
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore" });
    expect(removePresetMock).toHaveBeenCalledWith("alpha", currentCustomPolicy.name);
    expect(applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(consoleWarn.mock.calls.flat().join("\n")).toContain(
      "leaving live policy presets unchanged",
    );
  });
  it.each([
    "drift",
    null,
  ] as const)("does not remove built-in OTLP when its exact live content state is %s", async (gatewayState) => {
    getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
    } as never);
    getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: ["observability-otlp-local"],
    });
    getAppliedPresetsMock.mockReturnValue(["observability-otlp-local"]);
    getPresetContentGatewayStateMock.mockReturnValue(gatewayState);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(removePresetMock).not.toHaveBeenCalled();
    expect(consoleWarn.mock.calls.flat().join("\n")).toContain(
      "leaving its live policy content unchanged",
    );
  });

  it("normalizes a legacy restricted tier before deciding built-in OTLP egress", async () => {
    getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      policyTier: " Restricted ",
    } as never);
    getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
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
          content: "network_policies:\n  team-egress: {}\n",
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
        content: "network_policies:\n  team-egress: {}\n",
        sourcePath: "/policies/team.yaml",
      },
      { name: "old-custom", content: "network_policies:\n  old: {}\n", sourcePath: "/old.yaml" },
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
      failedDirReasons: { workspace: "permission denied" },
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
    expect(errors).toContain("Failed directories: workspace (permission denied), skills");
    expect(errors).toContain("Failed files: openclaw.json");
  });
});
