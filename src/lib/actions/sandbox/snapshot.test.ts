// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializedLlamaCppHostLocalInferenceReceipt } from "../../../../test/helpers/host-local-inference-receipt";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
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

  it(
    "rejects schema-5 snapshot creation before Docker or OpenShell work (#9203)",
    testTimeoutOptions(30_000),
    async () => {
      f.assertHermesPortableCommandUnavailableMock.mockImplementation(() => {
        throw new Error("schema-5 rejected");
      });
      const { runSandboxSnapshot } = await import("./snapshot");

      await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toThrow(
        "schema-5 rejected",
      );

      expect(f.captureOpenshellMock).not.toHaveBeenCalled();
      expect(f.dockerInspectMock).not.toHaveBeenCalled();
      expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
    },
  );

  it("rechecks schema-5 snapshot authority after the lifecycle lock is acquired (#9203)", async () => {
    f.assertHermesPortableCommandUnavailableMock
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("schema-5 appeared");
      });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toThrow(
      "schema-5 appeared",
    );

    expect(f.captureOpenshellMock).not.toHaveBeenCalled();
    expect(f.dockerInspectMock).not.toHaveBeenCalled();
    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();
  });

  it("rejects schema-5 snapshot listing inside the lifecycle fence (#9203)", async () => {
    f.assertHermesPortableCommandUnavailableMock.mockImplementation(() => {
      throw new Error("schema-5 list rejected");
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "list" })).rejects.toThrow(
      "schema-5 list rejected",
    );

    expect(f.listBackupsMock).not.toHaveBeenCalled();
    expect(f.captureOpenshellMock).not.toHaveBeenCalled();
    expect(f.dockerInspectMock).not.toHaveBeenCalled();
  });

  it("rejects a schema-5 snapshot restore source or destination before effects (#9203)", async () => {
    f.assertHermesPortableCommandUnavailableMock.mockImplementation((sandboxName: string) => {
      switch (sandboxName) {
        case "beta":
          throw new Error("schema-5 destination rejected");
      }
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore", to: "beta" })).rejects.toThrow(
      "schema-5 destination rejected",
    );

    expect(f.assertHermesPortableCommandUnavailableMock).toHaveBeenCalledWith(
      "alpha",
      "sandbox:snapshot:restore",
    );
    expect(f.assertHermesPortableCommandUnavailableMock).toHaveBeenCalledWith(
      "beta",
      "sandbox:snapshot:restore",
    );
    expect(f.captureOpenshellMock).not.toHaveBeenCalled();
    expect(f.dockerInspectMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

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

  it("creates a named snapshot after gateway and liveness checks pass", async () => {
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
    [
      "123 python3 -m deepagents_code --sandbox none --no-mcp -n work\n",
      "123 /opt/venv/bin/python3 -m deepagents_code --sandbox none --no-mcp -n work\n",
      "123 /opt/venv/bin/python3 -I -m deepagents_code --sandbox none --no-mcp -n work\n",
      "124 /usr/local/bin/dcode task\n",
      "125 /opt/bin/deepagents_code task\n",
      "126 /opt/bin/deepagents-code task\n",
    ].forEach((processLine) => {
      expect(runProbeScriptWithProcesses(probeScript, processLine)).toMatchObject({
        status: 0,
        output: expect.stringContaining("NEMOCLAW_DCODE_PROBE=active"),
      });
    });
    expect(
      runProbeScriptWithProcesses(probeScript, `999 sh -c ${shellCommandLine}\n`),
    ).toMatchObject({
      status: 0,
      output: expect.stringContaining("NEMOCLAW_DCODE_PROBE=no-runtime"),
    });
    [
      "127 cat /tmp/dcode\n",
      "128 grep deepagents-code notes.txt\n",
      "129 sh -lc python3 -m deepagents_code\n",
    ].forEach((processLine) => {
      expect(runProbeScriptWithProcesses(probeScript, processLine)).toMatchObject({
        status: 0,
        output: expect.stringContaining("NEMOCLAW_DCODE_PROBE=no-runtime"),
      });
    });
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
});
