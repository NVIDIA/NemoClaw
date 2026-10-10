// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { mockGatewayProcFiles } from "../../../test/helpers/mock-gateway-proc-files";
import { mockGatewayProcTaskDir } from "../../../test/helpers/mock-gateway-proc-task-dir";

import {
  gatewayIdForStateDir,
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
} from "./gateway/process-environment";
import {
  readDockerDriverGatewayProcessIdentity,
  readDockerDriverGatewayProcessEnvironment,
} from "./docker-driver-gateway-process-identity";
import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
} from "./docker-driver-gateway-config";
import { writeDockerDriverGatewayRuntimeMarkerForStateDir } from "./docker-driver-gateway-runtime-marker";
import { readGatewayProcEntry } from "./gateway/process-proc-entry";
import {
  externallySupervisedHostGatewayProcessOwnershipFailure,
  stopHostGatewayProcesses,
} from "./host-gateway-process";

const pid = 9_999_801;
const tid = 9_999_802;
const proc = `/proc/${pid}`;
const task = `${proc}/task/${tid}`;
const binary = "/opt/openshell-gateway";
const args = [binary, "--name", "nemoclaw-18080", "--port", "18080", ""].join("\0");
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-zombie-identity-"));
  roots.push(stateDir);
  fs.writeFileSync(path.join(stateDir, "openshell-gateway.pid"), String(pid));
  fs.writeFileSync(
    path.join(stateDir, "openshell-gateway.toml"),
    buildDockerDriverGatewayConfigToml(
      {
        OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:18080",
        OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls"),
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
      },
      "/usr/bin/openshell-sandbox",
      ensureDockerDriverGatewayJwtBundle(stateDir),
      gatewayIdForStateDir(stateDir),
    ),
    { mode: 0o600 },
  );
  writeDockerDriverGatewayRuntimeMarkerForStateDir(stateDir, {
    pid,
    desiredEnv: {},
    endpoint: "https://127.0.0.1:18080",
  });
  const files = new Map<string, string>([
    [`${proc}/cmdline`, ""],
    [`${proc}/status`, "State:\tZ (zombie)\n"],
    [`${task}/cmdline`, args],
    [
      `${task}/environ`,
      `${NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV}=${gatewayIdForStateDir(stateDir)}\0OPENSHELL_DRIVERS=docker\0`,
    ],
  ]);
  const readFile = fs.readFileSync;
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => files.has(String(file)) || exists(file));
  vi.spyOn(fs, "readFileSync").mockImplementation(
    (file, options) => files.get(String(file)) ?? readFile(file, options),
  );
  const procFiles = mockGatewayProcFiles(files);
  const taskDirectory = mockGatewayProcTaskDir(`${proc}/task`, [String(pid), String(tid)]);
  const realpath = fs.realpathSync.native;
  vi.spyOn(fs.realpathSync, "native").mockImplementation((file, options) =>
    String(file) === `${task}/exe` ? binary : realpath(file, options),
  );
  const outputs = new Map([
    ["stat=", "Z\nS\n"],
    ["args=", "[openshell-gatew] <defunct>"],
    ["command=", "[openshell-gatew] <defunct>"],
    ["uid=", String(process.getuid?.() ?? 501)],
  ]);
  const run = vi.fn((_command: string, argv: string[]) => ({
    status: 0,
    stdout: outputs.get(argv[argv.indexOf("-o") + 1]) ?? "",
    stderr: "",
  }));
  const kill = vi.fn(() => {
    outputs.set("stat=", "Z\nZ\n");
    return true;
  });
  const deps = { run, kill, env: {}, log: vi.fn(), isPortFree: () => true };
  const target = {
    pid,
    stateDir,
    gatewayBin: binary,
    gatewayName: "nemoclaw-18080",
    gatewayPort: 18080,
  };
  return { files, outputs, kill, deps, target, stateDir, taskDirectory, procFiles };
}

function stopScoped(f: ReturnType<typeof fixture>) {
  return stopHostGatewayProcesses(f.deps, {
    stateDir: f.stateDir,
    gatewayBin: binary,
    openShellGatewayName: "nemoclaw-18080",
    openShellGatewayPort: 18080,
    scopedGatewayStop: true,
    usePgrepFallback: false,
  });
}

describe.runIf(process.platform === "linux")("gateway identity after leader exit", () => {
  it("stops the owned gateway whose leader was already a zombie", () => {
    const f = fixture();
    const pidFile = path.join(f.stateDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, String(pid));
    const result = stopHostGatewayProcesses(f.deps, {
      stateDir: f.stateDir,
      gatewayBin: binary,
      openShellGatewayName: "nemoclaw-18080",
      openShellGatewayPort: 18080,
      usePgrepFallback: false,
      preserveRuntimeFilesOnNonMatching: true,
    });
    expect(result.stopped).toEqual([pid]);
    expect(f.kill.mock.calls).toEqual([[pid, "SIGTERM"]]);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("proves supervised ownership from the live thread's current identity", () => {
    const f = fixture();
    expect(externallySupervisedHostGatewayProcessOwnershipFailure(f.deps, f.target)).toBeNull();
  });

  it("rechecks scoped thread identity before stopping the selected gateway", () => {
    const f = fixture();
    expect(stopScoped(f).stopped).toEqual([pid]);
    expect(f.kill.mock.calls).toEqual([[pid, "SIGTERM"]]);
  });

  it("recovers scoped identity from an empty leader environment", () => {
    const f = fixture();
    f.files.set(`${proc}/environ`, "");
    expect(stopScoped(f).stopped).toEqual([pid]);
    expect(f.kill.mock.calls).toEqual([[pid, "SIGTERM"]]);
  });

  it("skips an empty sibling environment before reading the owned live thread", () => {
    const f = fixture();
    f.files.set(`${proc}/environ`, "");
    f.files.set(`${proc}/task/${tid + 1}/environ`, "");
    f.taskDirectory.setEntries([String(pid), String(tid + 1), String(tid)]);
    expect(stopScoped(f).stopped).toEqual([pid]);
    expect(f.kill.mock.calls).toEqual([[pid, "SIGTERM"]]);
  });

  it("bounds sibling identity reads and preserves ownership evidence when the bound is exceeded", () => {
    const f = fixture();
    f.files.set(`${proc}/environ`, "");
    const emptyTids = Array.from({ length: 70 }, (_, index) => String(tid + index + 1));
    emptyTids.forEach((emptyTid) => f.files.set(`${proc}/task/${emptyTid}/environ`, ""));
    f.taskDirectory.setEntries([
      String(pid),
      ...emptyTids.slice(0, 10),
      String(tid),
      ...emptyTids.slice(10),
    ]);
    expect(readGatewayProcEntry(pid, "environ")).toBe(f.files.get(`${task}/environ`));

    f.taskDirectory.setEntries([String(pid), ...emptyTids, String(tid)]);
    f.taskDirectory.resetCounts();
    f.procFiles.openedPaths.length = 0;
    expect(readGatewayProcEntry(pid, "environ")).toBeNull();
    expect(f.taskDirectory.reads).toBeLessThanOrEqual(65);
    expect(f.taskDirectory.closes).toBe(1);
    expect(
      f.procFiles.openedPaths.filter(
        (file) => file.startsWith(`${proc}/task/`) && file.endsWith("/environ"),
      ),
    ).toHaveLength(64);
    expect(stopScoped(f).ownershipFailures).toHaveLength(1);
    expect(f.kill).not.toHaveBeenCalled();
  });

  it.each(["cmdline", "environ"] as const)(
    "refuses an oversized sibling %s instead of trusting partial identity",
    (entry) => {
      const f = fixture();
      f.files.set(`${proc}/${entry}`, "");
      f.files.set(
        `${task}/${entry}`,
        `${f.files.get(`${task}/${entry}`)}FILLER=${"x".repeat(65_536)}`,
      );
      expect(stopScoped(f).ownershipFailures).toHaveLength(1);
      expect(f.kill).not.toHaveBeenCalled();
    },
  );

  it("keeps an empty environment for a non-zombie leader", () => {
    const f = fixture();
    f.files.set(`${proc}/status`, "State:\tS (sleeping)\n");
    f.files.set(`${proc}/cmdline`, args);
    f.files.set(`${proc}/environ`, "");
    expect(
      readDockerDriverGatewayProcessEnvironment(pid)?.[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV],
    ).toBeUndefined();
    expect(stopScoped(f).ownershipFailures).toHaveLength(1);
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("uses the same identity for runtime discovery and environment drift", () => {
    fixture();
    expect(readDockerDriverGatewayProcessIdentity(pid, () => "[openshell-gatew] <defunct>")).toBe(
      args.replaceAll("\0", " ").trim(),
    );
    expect(readDockerDriverGatewayProcessEnvironment(pid)?.OPENSHELL_DRIVERS).toBe("docker");
  });

  it.each([
    [
      "command",
      `${task}/cmdline`,
      ["/opt/unrelated", "--name", "nemoclaw-18080", "--port", "18080", ""].join("\0"),
    ],
    [
      "target",
      `${task}/cmdline`,
      [binary, "--name", "nemoclaw-18081", "--port", "18081", ""].join("\0"),
    ],
    ["namespace", `${task}/environ`, `${NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV}=another-state\0`],
    ["non-zombie leader", `${proc}/status`, "State:\tS (sleeping)\n"],
    ["empty sibling environment", `${task}/environ`, ""],
    [
      "existing leader environment",
      `${proc}/environ`,
      `${NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV}=another-state\0`,
    ],
    ["existing leader identity", `${proc}/cmdline`, "/opt/unrelated\0"],
  ])("refuses %s instead of inferring ownership from the PID", (_name, file, value) => {
    const f = fixture();
    f.files.set(file, value);
    expect(externallySupervisedHostGatewayProcessOwnershipFailure(f.deps, f.target)).not.toBeNull();
    expect(stopScoped(f).ownershipFailures).toHaveLength(1);
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("refuses another user's thread group", () => {
    const f = fixture();
    f.outputs.set("uid=", String((process.getuid?.() ?? 501) + 1));
    expect(externallySupervisedHostGatewayProcessOwnershipFailure(f.deps, f.target)).toContain(
      "owner",
    );
    expect(stopScoped(f).ownershipFailures).toHaveLength(1);
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("refuses a different executable even when the arguments match", () => {
    const f = fixture();
    expect(
      externallySupervisedHostGatewayProcessOwnershipFailure(f.deps, {
        ...f.target,
        gatewayBin: "/opt/other",
      }),
    ).toContain("executable");
  });

  it("keeps a readable leader command line when it mismatches", () => {
    const f = fixture();
    f.files.set(`${proc}/cmdline`, "/opt/unrelated\0");
    expect(readDockerDriverGatewayProcessIdentity(pid, () => args)).toBe("/opt/unrelated");
  });

  it("rejects vanished or unreadable sibling identity", () => {
    const f = fixture();
    f.files.delete(`${task}/cmdline`);
    expect(externallySupervisedHostGatewayProcessOwnershipFailure(f.deps, f.target)).not.toBeNull();
    expect(stopScoped(f).ownershipFailures).toHaveLength(1);
    expect(f.kill).not.toHaveBeenCalled();
  });
});
