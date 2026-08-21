// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { stopBedrockRuntimeAdapter } from "./openrouter-runtime-adapter-cleanup";

const PID = 43_210;
const REPLACEMENT_PID = 43_211;
const GENERATION = "11111111111111111111111111111111";
const REPLACEMENT_GENERATION = "22222222222222222222222222222222";
const PROCESS_START = "linux:test-boot:100";
const REPLACEMENT_PROCESS_START = "linux:test-boot:200";
const SCRIPT_PATH = "/opt/nemoclaw/scripts/bedrock-runtime-adapter.mts";
const EXECUTABLE_PATH = "/usr/bin/node";
const TOKEN = "bedrock-local-token";
const CURRENT_UID = process.getuid?.() ?? 501;
const CURRENT_USER = os.userInfo().username;

interface AdapterProcess {
  argv: readonly string[];
  executablePath: string;
  generation: string | null;
  processStart: string;
  uid: number;
  user: string;
}

function lifecyclePaths(home: string) {
  const root = path.join(home, ".local", "state", "nemoclaw-bedrock-runtime-adapter", "8080");
  return {
    journalPath: path.join(root, "uninstall.json"),
    lockPath: path.join(root, "lifecycle.lock"),
  };
}

function adapterPaths(home: string) {
  const stateDir = path.join(home, ".nemoclaw");
  return {
    pidPath: path.join(stateDir, "bedrock-runtime-adapter.pid"),
    stateDir,
    statePath: path.join(stateDir, "bedrock-runtime-adapter.json"),
    tokenPath: path.join(stateDir, "bedrock-runtime-adapter-token"),
  };
}

function adapterState(pid = PID, generation = GENERATION, processStart = PROCESS_START) {
  return {
    version: 2,
    generation,
    pid,
    processStart,
    user: CURRENT_USER,
    uid: CURRENT_UID,
    executablePath: EXECUTABLE_PATH,
    scriptPath: SCRIPT_PATH,
    adapterPort: 11_436,
    tokenHash: crypto.createHash("sha256").update(TOKEN).digest("hex"),
    endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    region: "us-east-1",
    credentialHash: "a".repeat(64),
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

function writeEvidence(
  home: string,
  state: { pid: number; [key: string]: unknown } = adapterState(),
  options: { pidText?: string; token?: string } = {},
): void {
  const paths = adapterPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.pidPath, options.pidText ?? `${String(state.pid)}\n`, { mode: 0o600 });
  fs.writeFileSync(paths.tokenPath, `${options.token ?? TOKEN}\n`, { mode: 0o600 });
  fs.writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function writeLegacyEvidence(home: string): void {
  writeEvidence(home, {
    pid: PID,
    endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    region: "us-east-1",
    credentialHash: "a".repeat(64),
    updatedAt: "2026-08-20T00:00:00.000Z",
  });
}

function writeFailedStartupEvidence(home: string): void {
  const paths = adapterPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.pidPath, `${String(PID)}\n`, { mode: 0o600 });
  fs.writeFileSync(paths.tokenPath, `${TOKEN}\n`, { mode: 0o600 });
}

function writePidOnlyEvidence(home: string): void {
  const paths = adapterPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.pidPath, `${String(PID)}\n`, { mode: 0o600 });
}

function writeJournal(
  home: string,
  phase:
    | "prepared"
    | "term-sent"
    | "kill-sent"
    | "process-absent"
    | "evidence-retiring"
    | "evidence-retired",
): void {
  const { journalPath } = lifecyclePaths(home);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    journalPath,
    `${JSON.stringify(
      {
        version: 1,
        phase,
        gatewayPort: 8080,
        generation: GENERATION,
        pid: PID,
        processStart: PROCESS_START,
        user: CURRENT_USER,
        uid: CURRENT_UID,
        executablePath: EXECUTABLE_PATH,
        scriptPath: SCRIPT_PATH,
        adapterPort: 11_436,
        tokenHash: crypto.createHash("sha256").update(TOKEN).digest("hex"),
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function managedProcess(overrides: Partial<AdapterProcess> = {}): AdapterProcess {
  return {
    argv: [EXECUTABLE_PATH, "--experimental-strip-types", "--no-warnings", SCRIPT_PATH],
    executablePath: EXECUTABLE_PATH,
    generation: GENERATION,
    processStart: PROCESS_START,
    uid: CURRENT_UID,
    user: CURRENT_USER,
    ...overrides,
  };
}

function cleanupHost(
  home: string,
  processes: Map<number, AdapterProcess>,
  options: {
    lsofPids?: readonly number[];
    lsofStatus?: number;
    onKill?: (pid: number, signal: NodeJS.Signals | number | undefined) => void;
    onRun?: (command: string, args: readonly string[]) => void;
  } = {},
) {
  const kills: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
  const lsofPorts: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  return {
    host: {
      commandExists: (command: string) => command === "lsof",
      env: { HOME: home, LOGNAME: CURRENT_USER } as NodeJS.ProcessEnv,
      existsSync: fs.existsSync,
      kill: (pid: number, signal?: NodeJS.Signals | number) => {
        kills.push({ pid, signal });
        options.onKill?.(pid, signal);
        return true;
      },
      log: (message: string) => logs.push(message),
      readProcessArgv: (pid: number) => processes.get(pid)?.argv ?? null,
      readProcessExecutable: (pid: number) => processes.get(pid)?.executablePath ?? null,
      readProcessEnvironment: (pid: number): Record<string, string> | null => {
        const generation = processes.get(pid)?.generation;
        return generation
          ? {
              NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_GENERATION: generation,
              NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT: "11436",
            }
          : generation === null
            ? { NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT: "11436" }
            : null;
      },
      readProcessIdentity: (pid: number) => processes.get(pid)?.processStart ?? null,
      run: (command: string, args: readonly string[]) => {
        options.onRun?.(command, args);
        switch (command) {
          case "lsof":
            lsofPorts.push(args[1] ?? "");
            return {
              status: options.lsofStatus ?? 0,
              stdout: `${(options.lsofPids ?? []).map(String).join("\n")}${options.lsofPids?.length ? "\n" : ""}`,
              stderr: "",
            };
          case "ps":
            break;
          default:
            return { status: 0, stdout: "", stderr: "" };
        }
        const pid = Number(args[1]);
        const observed = processes.get(pid);
        switch (observed) {
          case undefined:
            return { status: 1, stdout: "", stderr: "" };
        }
        const field = args.at(-1);
        switch (field) {
          case "pid=":
            return { status: 0, stdout: `${String(pid)}\n`, stderr: "" };
          case "uid=":
            return { status: 0, stdout: `${String(observed.uid)}\n`, stderr: "" };
          case "user=":
            return { status: 0, stdout: `${observed.user}\n`, stderr: "" };
          case "args=":
            return { status: 0, stdout: `${observed.argv.join(" ")}\n`, stderr: "" };
          default:
            return { status: 1, stdout: "", stderr: "" };
        }
      },
      sleep: vi.fn(),
      warn: (message: string) => warnings.push(message),
    },
    kills,
    lsofPorts,
    logs,
    warnings,
  };
}

function stop(home: string, host: ReturnType<typeof cleanupHost>["host"], scanOrphans = true) {
  return stopBedrockRuntimeAdapter({ nemoclawStateDir: adapterPaths(home).stateDir }, host, {
    gatewayPort: 8080,
    scanOrphans,
  });
}

describe("Bedrock Runtime adapter fail-closed uninstall cleanup (#9552)", () => {
  it("retires PID-only evidence after the startup child exits before identity capture", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-pid-only-"));
    writePidOnlyEvidence(home);
    const { host, kills, lsofPorts } = cleanupHost(home, new Map());

    try {
      expect(stop(home, host)).toMatchObject({ ok: true, status: "stopped", pid: PID });
      expect(kills).toEqual([]);
      expect(fs.existsSync(adapterPaths(home).pidPath)).toBe(false);

      expect(stop(home, host)).toMatchObject({ ok: true, status: "absent" });
      expect(kills).toEqual([]);
      expect(lsofPorts).toEqual([":11436"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not signal a live process from PID-only evidence", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-pid-only-live-"));
    writePidOnlyEvidence(home);
    const { host, kills } = cleanupHost(home, new Map([[PID, managedProcess()]]));

    try {
      expect(stop(home, host)).toMatchObject({
        ok: false,
        fatal: true,
        pid: PID,
        message: expect.stringContaining("cannot authorize a process signal"),
      });
      expect(kills).toEqual([]);
      expect(fs.existsSync(adapterPaths(home).pidPath)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves PID-only evidence when the recorded PID appears before deletion", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-pid-only-race-"));
    const processes = new Map<number, AdapterProcess>();
    writePidOnlyEvidence(home);
    const presenceProbeEffects = new Map([
      ["ps:pid=", [vi.fn(), vi.fn(() => processes.set(PID, managedProcess()))]],
    ]);
    const { host, kills } = cleanupHost(home, processes, {
      onRun: (command, args) => {
        presenceProbeEffects.get(`${command}:${args.at(-1) ?? ""}`)?.shift()?.();
      },
    });

    try {
      expect(stop(home, host)).toMatchObject({ ok: false, fatal: true, pid: PID });
      expect(kills).toEqual([]);
      expect(fs.existsSync(adapterPaths(home).pidPath)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("retires failed-startup PID and token evidence after proving process exit", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-startup-journal-"));
    const processes = new Map([[PID, managedProcess()]]);
    writeFailedStartupEvidence(home);
    writeJournal(home, "prepared");
    const { host, kills } = cleanupHost(home, processes, {
      onKill: (pid) => processes.delete(pid),
    });

    try {
      expect(stop(home, host)).toMatchObject({ ok: true, status: "stopped", pid: PID });
      expect(kills).toEqual([{ pid: PID, signal: "SIGTERM" }]);
      expect(fs.existsSync(adapterPaths(home).pidPath)).toBe(false);
      expect(fs.existsSync(adapterPaths(home).tokenPath)).toBe(false);
      expect(fs.existsSync(adapterPaths(home).statePath)).toBe(false);
      expect(fs.existsSync(lifecyclePaths(home).journalPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves failed-startup evidence when TERM and KILL cannot prove exit", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-startup-failure-"));
    const processes = new Map([[PID, managedProcess()]]);
    writeFailedStartupEvidence(home);
    writeJournal(home, "prepared");
    const { host, kills } = cleanupHost(home, processes);

    try {
      expect(stop(home, host)).toMatchObject({ ok: false, fatal: true, pid: PID });
      expect(kills).toEqual([
        { pid: PID, signal: "SIGTERM" },
        { pid: PID, signal: "SIGKILL" },
      ]);
      expect(fs.existsSync(adapterPaths(home).pidPath)).toBe(true);
      expect(fs.existsSync(adapterPaths(home).tokenPath)).toBe(true);
      expect(fs.existsSync(adapterPaths(home).statePath)).toBe(false);
      expect(fs.existsSync(lifecyclePaths(home).journalPath)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns a fatal result and preserves lifecycle evidence after TERM and KILL exhaustion", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-exhaustion-"));
    const processes = new Map([[PID, managedProcess()]]);
    writeEvidence(home);
    const { host, kills } = cleanupHost(home, processes);

    try {
      const result = stop(home, host);

      expect(result).toMatchObject({ ok: false, fatal: true, pid: PID });
      expect(kills).toEqual([
        { pid: PID, signal: "SIGTERM" },
        { pid: PID, signal: "SIGKILL" },
      ]);
      expect(fs.existsSync(adapterPaths(home).pidPath)).toBe(true);
      expect(fs.existsSync(adapterPaths(home).tokenPath)).toBe(true);
      expect(fs.existsSync(adapterPaths(home).statePath)).toBe(true);
      expect(fs.existsSync(lifecyclePaths(home).journalPath)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not signal when the canonical PID file and lifecycle state disagree", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-pid-mismatch-"));
    writeEvidence(home, adapterState(REPLACEMENT_PID), { pidText: `${String(PID)}\n` });
    const { host, kills } = cleanupHost(home, new Map([[PID, managedProcess()]]));

    try {
      expect(stop(home, host)).toMatchObject({ ok: false, fatal: true });
      expect(kills).toEqual([]);
      expect(fs.existsSync(adapterPaths(home).statePath)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves absent lifecycle evidence whose adapter port differs from configuration", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-port-mismatch-"));
    writeEvidence(home, { ...adapterState(), adapterPort: 11_437 });
    const { host, kills } = cleanupHost(home, new Map());

    try {
      expect(stop(home, host)).toMatchObject({
        ok: false,
        fatal: true,
        pid: PID,
        message: expect.stringContaining("configured adapter port"),
      });
      expect(kills).toEqual([]);
      expect(fs.existsSync(adapterPaths(home).pidPath)).toBe(true);
      expect(fs.existsSync(adapterPaths(home).tokenPath)).toBe(true);
      expect(fs.existsSync(adapterPaths(home).statePath)).toBe(true);
      expect(fs.existsSync(lifecyclePaths(home).journalPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a PID file with a numeric prefix and trailing data", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-pid-format-"));
    writeEvidence(home, adapterState(), { pidText: `${String(PID)}-replacement\n` });
    const { host, kills } = cleanupHost(home, new Map([[PID, managedProcess()]]));

    try {
      expect(stop(home, host)).toMatchObject({ ok: false, fatal: true });
      expect(kills).toEqual([]);
      expect(fs.readFileSync(adapterPaths(home).pidPath, "utf8")).toBe(
        `${String(PID)}-replacement\n`,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    {
      expectedWarning: false,
      label: "another user",
      process: managedProcess({ uid: CURRENT_UID + 1, user: "foreignuser" }),
    },
    {
      expectedWarning: true,
      label: "another canonical launcher path",
      process: managedProcess({
        argv: [
          EXECUTABLE_PATH,
          "--experimental-strip-types",
          "--no-warnings",
          "/tmp/foreign/bedrock-runtime-adapter.mts",
        ],
      }),
    },
  ])(
    "does not signal an exact-basename listener owned by $label",
    ({ expectedWarning, process }) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-foreign-"));
      const { host, kills, logs, warnings } = cleanupHost(home, new Map([[PID, process]]), {
        lsofPids: [PID],
      });

      try {
        expect(stop(home, host)).toMatchObject({ ok: true });
        expect(kills).toEqual([]);
        expect(warnings.some((message) => message.includes("unbound Bedrock"))).toBe(
          expectedWarning,
        );
        expect(logs.includes("No Bedrock Runtime adapter processes found")).toBe(!expectedWarning);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("reports an unavailable full-uninstall orphan scan without claiming absence", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-lsof-error-"));
    const { host, kills, logs, warnings } = cleanupHost(home, new Map(), { lsofStatus: 2 });

    try {
      expect(stop(home, host)).toMatchObject({ ok: true, status: "absent" });
      expect(kills).toEqual([]);
      expect(warnings).toContain(
        "Bedrock Runtime adapter orphan scan could not inspect the configured port; no process was signaled.",
      );
      expect(logs).not.toContain("No Bedrock Runtime adapter processes found");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not send KILL to a replacement that reuses the recorded PID", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-reused-pid-"));
    const processes = new Map([[PID, managedProcess()]]);
    writeEvidence(home);
    const { host, kills } = cleanupHost(home, processes, {
      onKill: (_pid, signal) => {
        switch (signal) {
          case "SIGTERM":
            processes.set(
              PID,
              managedProcess({
                generation: REPLACEMENT_GENERATION,
                processStart: REPLACEMENT_PROCESS_START,
              }),
            );
            break;
        }
      },
    });

    try {
      expect(stop(home, host)).toMatchObject({ ok: false, fatal: true });
      expect(kills).toEqual([{ pid: PID, signal: "SIGTERM" }]);
      expect(fs.existsSync(adapterPaths(home).statePath)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not signal a live adapter whose legacy state lacks generation identity", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-legacy-"));
    const processes = new Map([[PID, managedProcess({ generation: null })]]);
    writeLegacyEvidence(home);
    const { host, kills } = cleanupHost(home, processes);

    try {
      expect(stop(home, host)).toMatchObject({ ok: false, fatal: true, pid: PID });
      expect(kills).toEqual([]);
      expect(fs.existsSync(lifecyclePaths(home).journalPath)).toBe(true);

      processes.delete(PID);
      expect(stop(home, host)).toMatchObject({ ok: true, status: "stopped", pid: PID });
      expect(fs.existsSync(adapterPaths(home).statePath)).toBe(false);
      expect(fs.existsSync(lifecyclePaths(home).journalPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("retires legacy evidence when its recorded process is already absent", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-legacy-absent-"));
    writeLegacyEvidence(home);
    const { host, kills } = cleanupHost(home, new Map());

    try {
      expect(stop(home, host)).toMatchObject({ ok: true, status: "stopped", pid: PID });
      expect(kills).toEqual([]);
      expect(fs.existsSync(adapterPaths(home).pidPath)).toBe(false);
      expect(fs.existsSync(adapterPaths(home).tokenPath)).toBe(false);
      expect(fs.existsSync(adapterPaths(home).statePath)).toBe(false);
      expect(fs.existsSync(lifecyclePaths(home).journalPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses full-uninstall discovery to stop an owned listener whose PID file is absent", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-orphan-"));
    const processes = new Map([[PID, managedProcess()]]);
    writeEvidence(home);
    fs.unlinkSync(adapterPaths(home).pidPath);
    const { host, kills, lsofPorts } = cleanupHost(home, processes, {
      lsofPids: [PID],
      onKill: (pid) => processes.delete(pid),
    });

    try {
      expect(stop(home, host)).toMatchObject({ ok: true, status: "stopped", pid: PID });
      expect(kills).toEqual([{ pid: PID, signal: "SIGTERM" }]);
      expect(lsofPorts).toEqual([":11436"]);
      expect(fs.existsSync(adapterPaths(home).statePath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("retires state for an already-absent process without requiring orphan discovery", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-absent-orphan-"));
    writeEvidence(home);
    fs.unlinkSync(adapterPaths(home).pidPath);
    const { host, kills, lsofPorts } = cleanupHost(home, new Map());

    try {
      expect(stop(home, host)).toMatchObject({ ok: true, status: "stopped", pid: PID });
      expect(kills).toEqual([]);
      expect(lsofPorts).toEqual([]);
      expect(fs.existsSync(adapterPaths(home).statePath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves a concurrent new generation before lifecycle evidence deletion", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-new-generation-"));
    const processes = new Map([[PID, managedProcess()]]);
    writeEvidence(home);
    const { host } = cleanupHost(home, processes, {
      onKill: (_pid, signal) => {
        switch (signal) {
          case "SIGTERM":
            processes.delete(PID);
            writeEvidence(
              home,
              adapterState(REPLACEMENT_PID, REPLACEMENT_GENERATION, REPLACEMENT_PROCESS_START),
            );
            break;
        }
      },
    });

    try {
      expect(stop(home, host)).toMatchObject({ ok: false, fatal: true });
      const current = JSON.parse(fs.readFileSync(adapterPaths(home).statePath, "utf8"));
      expect(current.generation).toBe(REPLACEMENT_GENERATION);
      expect(fs.existsSync(adapterPaths(home).tokenPath)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves a resumed journal after the configured adapter port drifts", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-resume-port-"));
    writeEvidence(home);
    writeJournal(home, "term-sent");
    const journalBefore = fs.readFileSync(lifecyclePaths(home).journalPath, "utf8");
    const { host, kills } = cleanupHost(home, new Map([[PID, managedProcess()]]));
    host.env.NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT = "11437";

    try {
      expect(stop(home, host)).toMatchObject({
        ok: false,
        fatal: true,
        message: expect.stringContaining("configured adapter port"),
      });
      expect(kills).toEqual([]);
      expect(fs.existsSync(adapterPaths(home).pidPath)).toBe(true);
      expect(fs.existsSync(adapterPaths(home).tokenPath)).toBe(true);
      expect(fs.existsSync(adapterPaths(home).statePath)).toBe(true);
      expect(fs.readFileSync(lifecyclePaths(home).journalPath, "utf8")).toBe(journalBefore);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["prepared", "SIGTERM", true],
    ["term-sent", "SIGTERM", true],
    ["kill-sent", "SIGKILL", true],
    ["process-absent", null, false],
    ["evidence-retiring", null, false],
    ["evidence-retired", null, false],
  ] as const)("resumes an interrupted %s phase", (phase, expectedSignal, processInitiallyLive) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-resume-"));
    const processes = new Map<number, AdapterProcess>();
    processInitiallyLive ? processes.set(PID, managedProcess()) : undefined;
    phase !== "evidence-retired" ? writeEvidence(home) : undefined;
    writeJournal(home, phase);
    const { host, kills } = cleanupHost(home, processes, {
      onKill: (pid) => processes.delete(pid),
    });

    try {
      expect(stop(home, host)).toMatchObject({ ok: true });
      expect(kills.map(({ signal }) => signal)).toEqual(expectedSignal ? [expectedSignal] : []);
      expect(fs.existsSync(adapterPaths(home).pidPath)).toBe(false);
      expect(fs.existsSync(adapterPaths(home).tokenPath)).toBe(false);
      expect(fs.existsSync(adapterPaths(home).statePath)).toBe(false);
      expect(fs.existsSync(lifecyclePaths(home).journalPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves evidence that reappears after the journal recorded retirement", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-retired-race-"));
    writeEvidence(home);
    writeJournal(home, "evidence-retired");
    const { host, kills } = cleanupHost(home, new Map());

    try {
      expect(stop(home, host)).toMatchObject({ ok: false, fatal: true });
      expect(kills).toEqual([]);
      expect(fs.existsSync(adapterPaths(home).pidPath)).toBe(true);
      expect(fs.existsSync(adapterPaths(home).tokenPath)).toBe(true);
      expect(fs.existsSync(adapterPaths(home).statePath)).toBe(true);
      expect(fs.existsSync(lifecyclePaths(home).journalPath)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves remaining evidence when the PID is reused during retirement", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-retire-reuse-"));
    writeEvidence(home);
    writeJournal(home, "process-absent");
    const processes = new Map<number, AdapterProcess>();
    const cleanup = cleanupHost(home, processes);
    const originalExistsSync = cleanup.host.existsSync;
    cleanup.host.existsSync = (target) => {
      switch (
        target === adapterPaths(home).tokenPath &&
        !fs.existsSync(adapterPaths(home).pidPath)
      ) {
        case true:
          processes.set(
            PID,
            managedProcess({
              generation: REPLACEMENT_GENERATION,
              processStart: REPLACEMENT_PROCESS_START,
            }),
          );
          break;
      }
      return originalExistsSync(target);
    };

    try {
      expect(stop(home, cleanup.host)).toMatchObject({ ok: false, fatal: true, pid: PID });
      expect(cleanup.kills).toEqual([]);
      expect(fs.existsSync(adapterPaths(home).pidPath)).toBe(false);
      expect(fs.existsSync(adapterPaths(home).tokenPath)).toBe(true);
      expect(fs.existsSync(adapterPaths(home).statePath)).toBe(true);
      expect(fs.existsSync(lifecyclePaths(home).journalPath)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("makes a completed second uninstall a no-mutation success", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-second-"));
    const processes = new Map([[PID, managedProcess()]]);
    writeEvidence(home);
    const { host, kills } = cleanupHost(home, processes, {
      onKill: (pid) => processes.delete(pid),
    });

    try {
      expect(stop(home, host)).toMatchObject({ ok: true });
      const firstKillCount = kills.length;
      expect(stop(home, host)).toMatchObject({ ok: true, status: "absent" });
      expect(kills).toHaveLength(firstKillCount);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps orphan discovery and sibling evidence outside selected-gateway cleanup", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-stop-selected-"));
    const processes = new Map([[PID, managedProcess()]]);
    writeEvidence(home);
    const siblingDir = path.join(adapterPaths(home).stateDir, "gateways", "8091");
    fs.mkdirSync(siblingDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(siblingDir, "bedrock-runtime-adapter.pid"),
      `${String(REPLACEMENT_PID)}\n`,
      {
        mode: 0o600,
      },
    );
    fs.writeFileSync(path.join(siblingDir, "bedrock-runtime-adapter-token"), `${TOKEN}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(siblingDir, "bedrock-runtime-adapter.json"),
      `${JSON.stringify(
        adapterState(REPLACEMENT_PID, REPLACEMENT_GENERATION, REPLACEMENT_PROCESS_START),
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const { host, kills, lsofPorts } = cleanupHost(home, processes, {
      lsofPids: [REPLACEMENT_PID],
      onKill: (pid) => processes.delete(pid),
    });
    let siblingInspected = false;
    const originalExistsSync = host.existsSync;
    host.existsSync = (target) => {
      siblingInspected ||= String(target).startsWith(siblingDir);
      return originalExistsSync(target);
    };

    try {
      expect(stop(home, host, false)).toMatchObject({ ok: true, status: "stopped", pid: PID });
      expect(kills).toEqual([{ pid: PID, signal: "SIGTERM" }]);
      expect(lsofPorts).toEqual([]);
      expect(siblingInspected).toBe(false);
      expect(fs.existsSync(path.join(siblingDir, "bedrock-runtime-adapter.json"))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
