// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type IdlePlan = {
  agent?: "hermes";
  stateRoot?: string;
  windowsRoot?: string;
  installRoot: string;
  guardianPid: number;
  guardianStartedUtc: string;
  hostPid: number;
  hostStartedUtc: string;
  runtimeId: string;
  sourceRevision: string;
  manifestSha256: string;
};
const roles = [
  "guardian",
  "host-runtime",
  "openshell-gateway",
  "native-window",
  "ui-relay",
  "inference-relay",
  "mxc-executor",
  "contained-node",
  "observer",
] as const;
const hermesRoles = [
  "guardian",
  "host-runtime",
  "openshell-gateway",
  "native-window",
  "hermes-ui-relay",
  "hermes-broker-relay",
  "hermes-status-owner",
  "hermes-state-session-owner",
  "hermes-runtime-session-owner",
  "mxc-executor",
  "hermes-launcher",
  "contained-node",
  "observer",
] as const;

type Relation = {
  processId: number;
  parentProcessId: number;
  executable: string;
  creationFileTime: string;
  parentCreationFileTime: string;
};
const normalized = (value: string) => path.win32.normalize(value).toLowerCase();
export function hermesIdleProcessRole(
  image: string,
  processId: number,
  installRoot: string,
  runtimeId: string,
  windowsRoot: string,
) {
  const root = path.win32.join(installRoot, "runtimes", runtimeId, "hermes");
  const images = {
    "hermes-python": path.win32.join(
      root,
      "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/python.exe",
    ),
    "hermes-python-redirector": path.win32.join(root, "hermes-agent/venv/Scripts/python.exe"),
    "hermes-tui-node": path.win32.join(root, "node/node.exe"),
    "hermes-browser-use-python": path.win32.join(root, "tools/browser-use/Scripts/python.exe"),
    "hermes-console-host": path.win32.join(windowsRoot, "System32/conhost.exe"),
  };
  for (const [role, expected] of Object.entries(images))
    if (normalized(image) === normalized(expected)) return role + "-" + processId;
  const relative = path.win32.relative(root, image);
  assert(
    relative &&
      relative !== ".." &&
      !relative.startsWith("..\\") &&
      !path.win32.isAbsolute(relative) &&
      /\.exe$/iu.test(relative),
    "The observed Hermes descendant is outside its canonical images",
  );
  return "hermes-tool-" + processId;
}

const counterNames = [
  "kernel100ns",
  "user100ns",
  "readOperations",
  "writeOperations",
  "otherOperations",
  "readTransferBytes",
  "writeTransferBytes",
  "otherTransferBytes",
] as const;
type CounterName = (typeof counterNames)[number];
type Row = Record<CounterName, string> & {
  role: string;
  processId: number;
  creationFileTime: string;
  executable: string;
  capturedTicks: string;
};
type Complete = {
  agent?: "hermes";
  stateRoot?: string;
  windowsRoot?: string;
  processRelations?: Relation[];
  kind: "complete";
  schemaVersion: 1;
  runtimeId: string;
  sourceRevision: string;
  manifestSha256: string;
  requestedIdleMs: number;
  clock: string;
  frequency: string;
  logicalProcessors: number;
  preparationMs: number;
  observerTotalMs: number;
  frames: { processes: Row[]; captureTicks: string }[];
  applicationInstrumentationEnabled: false;
  scenario: string;
  relayCounters: null;
};
const uint = (value: unknown) => {
  assert.equal(typeof value, "string");
  assert.match(value as string, /^(?:0|[1-9][0-9]{0,19})$/u);
  const number = BigInt(value as string);
  assert(number <= 0xffffffffffffffffn);
  return number;
};

export function validateIdlePlan(plan: IdlePlan) {
  assert.deepEqual(
    Object.keys(plan).sort(),
    [
      "installRoot",
      "guardianPid",
      "guardianStartedUtc",
      "hostPid",
      "hostStartedUtc",
      "runtimeId",
      "sourceRevision",
      "manifestSha256",
      ...(plan.agent === "hermes" ? ["agent", "stateRoot", "windowsRoot"] : []),
    ].sort(),
  );
  if (plan.agent !== undefined) {
    assert.equal(plan.agent, "hermes");
    assert.equal(typeof plan.stateRoot, "string");
    assert.equal(typeof plan.windowsRoot, "string");
    assert.match(plan.stateRoot!, /^[A-Za-z]:\\NemoClawState-S-1-(?:\d+-)*\d+-hermes$/u);
    assert.match(plan.windowsRoot!, /^[A-Za-z]:\\[^\r\n\0]{1,4000}$/u);
    assert(!plan.windowsRoot!.split("\\").some((part) => part === "." || part === ".."));
    assert.equal(
      path.win32.parse(plan.stateRoot!).root.toLowerCase(),
      path.win32.parse(plan.windowsRoot!).root.toLowerCase(),
    );
  }
  assert.match(plan.installRoot, /^[A-Za-z]:\\[^\r\n\0]{1,4000}$/u);
  assert(!plan.installRoot.split("\\").some((part) => part === ".." || part === "."));
  for (const key of ["guardianPid", "hostPid"] as const)
    assert(Number.isSafeInteger(plan[key]) && plan[key] > 0 && plan[key] <= 0x7fffffff);
  assert.notEqual(plan.guardianPid, plan.hostPid);
  for (const key of ["guardianStartedUtc", "hostStartedUtc"] as const) {
    assert.match(plan[key], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u);
    assert(Number.isFinite(Date.parse(plan[key])));
  }
  assert.match(plan.runtimeId, /^[a-f0-9]{64}$/u);
  assert.match(plan.manifestSha256, /^[a-f0-9]{64}$/u);
  assert.match(plan.sourceRevision, /^[a-f0-9]{40}$/u);
  return { schemaVersion: 1, ...plan, controllerPid: process.pid, durationMs: 30000 };
}

export function summarizeIdle(
  result: Complete,
  expected: Pick<
    IdlePlan,
    "runtimeId" | "sourceRevision" | "manifestSha256" | "guardianPid" | "hostPid"
  > &
    Partial<Pick<IdlePlan, "agent" | "installRoot" | "stateRoot" | "windowsRoot">>,
) {
  assert.equal(result.kind, "complete");
  assert.equal(result.schemaVersion, 1);
  for (const key of ["runtimeId", "sourceRevision", "manifestSha256"] as const)
    assert.equal(result[key], expected[key]);
  assert.equal(result.requestedIdleMs, 30000);
  assert.equal(result.clock, "Stopwatch.GetTimestamp");
  assert.equal(result.applicationInstrumentationEnabled, false);
  assert.equal(result.relayCounters, null);
  assert.equal(result.scenario, "settled-response-browser-connected-no-user-actions");
  const frequency = uint(result.frequency);
  assert(frequency > 0);
  assert(
    Number.isSafeInteger(result.logicalProcessors) &&
      result.logicalProcessors > 0 &&
      result.logicalProcessors <= 4096,
  );
  assert(
    Number.isFinite(result.preparationMs) &&
      result.preparationMs >= 0 &&
      result.preparationMs < 10000,
  );
  assert(
    Number.isFinite(result.observerTotalMs) &&
      result.observerTotalMs >= 30000 &&
      result.observerTotalMs <= 45000,
  );
  assert.equal(result.frames.length, 2);
  const [first, last] = result.frames;
  const isHermes = expected.agent === "hermes";
  assert.equal(result.agent, expected.agent);
  for (const frame of result.frames) {
    if (isHermes) {
      assert(frame.processes.length > hermesRoles.length && frame.processes.length <= 45);
      assert.equal(new Set(frame.processes.map((row) => row.role)).size, frame.processes.length);
      for (const role of hermesRoles)
        assert.equal(frame.processes.filter((row) => row.role === role).length, 1);
      assert(
        frame.processes.some((row) => /^hermes-python-[0-9]+$/u.test(row.role)),
        "The real canonical Python was not measured",
      );
      for (const row of frame.processes.filter(
        (row) => !hermesRoles.includes(row.role as (typeof hermesRoles)[number]),
      ))
        assert.equal(
          row.role,
          hermesIdleProcessRole(
            row.executable,
            row.processId,
            expected.installRoot!,
            expected.runtimeId,
            expected.windowsRoot!,
          ),
        );
    } else {
      assert.equal(frame.processes.length, roles.length);
      assert.deepEqual(frame.processes.map((row) => row.role).sort(), [...roles].sort());
    }
    assert.equal(new Set(frame.processes.map((row) => row.processId)).size, frame.processes.length);
    uint(frame.captureTicks);
  }
  if (isHermes) {
    assert.equal(typeof expected.installRoot, "string");
    assert.equal(typeof expected.windowsRoot, "string");
    assert.equal(normalized(result.stateRoot!), normalized(expected.stateRoot!));
    assert.equal(normalized(result.windowsRoot!), normalized(expected.windowsRoot!));
    const install = expected.installRoot!;
    const runtime = path.win32.join(install, "runtimes", expected.runtimeId);
    const fixed = {
      guardian: path.win32.join(install, "bin/NemoClaw.exe"),
      "host-runtime": path.win32.join(runtime, "app/NemoClaw.Runtime.exe"),
      "openshell-gateway": path.win32.join(install, "bin/openshell-gateway.exe"),
      "native-window": path.win32.join(install, "native-ui/NemoClaw.Bootstrapper.exe"),
      "hermes-ui-relay": path.win32.join(install, "bin/NemoClaw.exe"),
      "hermes-broker-relay": path.win32.join(install, "bin/NemoClaw.exe"),
      "hermes-status-owner": path.win32.join(install, "bin/NemoClaw.exe"),
      "hermes-state-session-owner": path.win32.join(install, "bin/NemoClaw.exe"),
      "hermes-runtime-session-owner": path.win32.join(install, "bin/NemoClaw.exe"),
      "mxc-executor": path.win32.join(runtime, "hermes/mxc-compat/wxc-exec.exe"),
      "hermes-launcher": path.win32.join(runtime, "hermes/mxc-compat/NemoClawMsysLauncher.exe"),
      "contained-node": path.win32.join(install, "bin/node.exe"),
      observer: path.win32.join(
        path.win32.dirname(path.win32.dirname(install)),
        "PowerShell/7/pwsh.exe",
      ),
    };
    for (const [role, image] of Object.entries(fixed))
      assert.equal(
        normalized(first.processes.find((row) => row.role === role)!.executable),
        normalized(image),
      );
    assert(Array.isArray(result.processRelations) && result.processRelations.length <= 64);
    const relations = new Map(result.processRelations.map((row) => [row.processId, row]));
    assert.equal(relations.size, result.processRelations.length);
    const held = new Map(first.processes.map((row) => [row.processId, row]));
    const ancestors = (id: number) => {
      const chain: number[] = [];
      while (id !== expected.hostPid) {
        assert(chain.length < 32 && !chain.includes(id), "Invalid held process ancestry");
        chain.push(id);
        const edge = relations.get(id);
        assert(edge);
        assert(Number.isSafeInteger(edge.parentProcessId) && edge.parentProcessId > 0);
        const parent = held.get(edge.parentProcessId) ?? relations.get(edge.parentProcessId);
        assert(parent);
        assert.equal(
          edge.parentCreationFileTime,
          parent.creationFileTime,
          "Parent PID generation changed",
        );
        assert(uint(edge.creationFileTime) >= uint(parent.creationFileTime));
        id = edge.parentProcessId;
      }
      return chain;
    };
    for (const row of first.processes.filter(
      (row) => !["guardian", "host-runtime", "observer"].includes(row.role),
    )) {
      const edge = relations.get(row.processId);
      assert(edge);
      assert.equal(edge.creationFileTime, row.creationFileTime);
      assert.equal(normalized(edge.executable), normalized(row.executable));
      const chain = ancestors(row.processId);
      if (!hermesRoles.includes(row.role as (typeof hermesRoles)[number])) {
        const wanted = [
          "contained-node",
          "hermes-launcher",
          "mxc-executor",
          "openshell-gateway",
        ].map((role) => first.processes.find((value) => value.role === role)!.processId);
        const indexes = wanted.map((id) => chain.indexOf(id));
        assert(
          indexes.every(
            (value, index) => value >= 0 && (index === 0 || value > indexes[index - 1]),
          ),
          "Hermes process is outside the exact contained chain",
        );
      }
    }
  }
  assert.equal(
    first.processes.find((row) => row.role === "guardian")?.processId,
    expected.guardianPid,
  );
  assert.equal(
    first.processes.find((row) => row.role === "host-runtime")?.processId,
    expected.hostPid,
  );
  const rows = first.processes.map((before) => {
    const after = last.processes.find((row) => row.role === before.role)!;
    assert(Number.isSafeInteger(before.processId) && before.processId > 0);
    assert.equal(after.processId, before.processId);
    assert.equal(after.creationFileTime, before.creationFileTime);
    assert(uint(before.creationFileTime) > 0);
    assert.equal(typeof before.executable, "string");
    assert(before.executable.length > 0 && before.executable.length <= 4096);
    assert.equal(after.executable.toLowerCase(), before.executable.toLowerCase());
    const ticks = uint(after.capturedTicks) - uint(before.capturedTicks);
    const elapsedMs = (Number(ticks) * 1000) / Number(frequency);
    assert(elapsedMs >= 30000 && elapsedMs <= 45000, "The complete idle interval was censored.");
    const differences = Object.fromEntries(
      counterNames.map((key) => {
        const delta = uint(after[key]) - uint(before[key]);
        assert(delta >= 0);
        return [key, delta.toString()];
      }),
    ) as Record<CounterName, string>;
    const kernelMs = Number(BigInt(differences.kernel100ns)) / 10000;
    const userMs = Number(BigInt(differences.user100ns)) / 10000;
    return {
      role: before.role,
      processId: before.processId,
      executable: before.executable,
      creationFileTime: before.creationFileTime,
      elapsedMs,
      kernelMs,
      userMs,
      cpuMs: kernelMs + userMs,
      cpuPercentOfOneLogicalProcessor: (100 * (kernelMs + userMs)) / elapsedMs,
      cpuPercentOfReportedLogicalCapacity:
        (100 * (kernelMs + userMs)) / elapsedMs / result.logicalProcessors,
      counters: differences,
    };
  });
  return {
    targets: rows.filter((row) => row.role !== "observer"),
    observer: rows.find((row) => row.role === "observer"),
    observerPreparationMs: result.preparationMs,
    observerCpuBeforeSampleMs:
      Number(
        uint(first.processes.find((row) => row.role === "observer")!.kernel100ns) +
          uint(first.processes.find((row) => row.role === "observer")!.user100ns),
      ) / 10000,
    observerCpuThroughLastSampleMs:
      Number(
        uint(last.processes.find((row) => row.role === "observer")!.kernel100ns) +
          uint(last.processes.find((row) => row.role === "observer")!.user100ns),
      ) / 10000,
    observerCaptureMs:
      (Number(result.frames.reduce((sum, frame) => sum + uint(frame.captureTicks), 0n)) * 1000) /
      Number(frequency),
    ioScope: "general per-process I/O; not file-only, copied bytes or native flushes",
    processScope: isHermes
      ? "individually held Hermes canonical process tree with PID/image/parent-generation proof; no process aggregate or transient-child attribution"
      : "individually held roles; no automatic descendant or browser aggregation",
    modelLatencyMs: null,
    relayCounters: null,
    unavailable: [
      "logical relay slot scans",
      "per-frame native flush timing",
      "physical disk or scanner attribution",
      "isolated model latency",
    ],
  };
}

// Only the observer ChildProcess is controlled. No PID/name from its output is killed.
export async function collectIdleObserver(child: ChildProcess, workMs = 40000, cleanupMs = 5000) {
  assert(Number.isSafeInteger(workMs) && workMs > 0 && workMs <= 40000);
  assert(Number.isSafeInteger(cleanupMs) && cleanupMs > 0 && cleanupMs <= 5000);
  let failure: Error | undefined;
  let pending = "",
    received = 0,
    stderrBytes = 0;
  const records: Record<string, unknown>[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const stop = (message: string) => {
    failure ??= new Error(message);
    if (killTimer) return;
    killTimer = setTimeout(settle, cleanupMs);
    try {
      child.kill();
    } catch {
      failure ??= new Error("The owned observer could not stop.");
    }
  };
  child.stdin?.on("error", () => stop("The owned observer input closed unexpectedly."));
  child.stdin?.end();
  child.stdout?.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > 128 * 1024) {
      stop("The idle observer output exceeded its bound.");
      return;
    }
    pending += chunk.toString("utf8");
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        assert(value && typeof value === "object" && value.schemaVersion === 1);
        assert(records.length < 2 && ["ready", "complete", "failure"].includes(value.kind));
        assert(
          value.kind === "failure" || value.kind === (records.length === 0 ? "ready" : "complete"),
        );
        records.push(value);
      } catch {
        stop("The idle observer protocol was invalid.");
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 8192) stop("The idle observer error output exceeded its bound.");
  });
  child.once("error", () => stop("The idle observer could not run."));
  let closed = false,
    exitCode: number | null = null;
  child.once("close", (code) => {
    closed = true;
    exitCode = code;
    settle();
  });
  timer = setTimeout(() => stop("The idle observer exceeded its work deadline."), workMs);
  try {
    await done;
    if (!closed) failure ??= new Error("The owned observer exit was not confirmed.");
    if (pending.trim()) failure ??= new Error("The observer left an incomplete output record.");
    if (exitCode !== 0 || records.length !== 2 || records[1]?.kind !== "complete")
      failure ??= new Error("The idle observation did not complete.");
    return {
      exitCode,
      observerExitConfirmed: closed,
      receivedBytes: received,
      stderrBytes,
      records,
      failure: failure?.message ?? null,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
  }
}

export async function sampleInstalledIdle(plan: IdlePlan, outputPath: string) {
  assert.equal(process.platform, "win32");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const checked = validateIdlePlan(plan);
  const owner = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(owner, "sample-installed-idle.ps1");
  const counter = path.join(owner, "InstalledIdleCounter.cs");
  const powershell = path.join(process.env.ProgramFiles ?? "", "PowerShell", "7", "pwsh.exe");
  for (const file of [script, counter, powershell]) assert(fs.statSync(file).isFile());
  const planPath = outputPath + ".plan.json";
  fs.writeFileSync(planPath, JSON.stringify(checked) + "\n", { flag: "wx" });
  const allowed = new Set([
    "systemroot",
    "windir",
    "systemdrive",
    "comspec",
    "path",
    "pathext",
    "temp",
    "tmp",
    "programfiles",
    "programfiles(x86)",
    "psmodulepath",
    "os",
    "processor_architecture",
    "github_actions",
    "userprofile",
    "localappdata",
    "appdata",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())),
  );
  const child = spawn(
    powershell,
    ["-NoProfile", "-NonInteractive", "-File", script, "-PlanPath", planPath],
    { env, windowsHide: true, cwd: path.dirname(outputPath), stdio: ["pipe", "pipe", "pipe"] },
  );
  const observed = await collectIdleObserver(child);
  let summary: ReturnType<typeof summarizeIdle> | null = null;
  let error = observed.failure;
  if (!error)
    try {
      summary = summarizeIdle(observed.records[1] as unknown as Complete, plan);
    } catch {
      error = "The idle observer counters or identity failed validation.";
    }
  const receipt = {
    schemaVersion: 1,
    classification: "installed-windows-idle-process-observation",
    status: error ? "failed" : "measured",
    error,
    runtime: {
      runtimeId: plan.runtimeId,
      sourceRevision: plan.sourceRevision,
      manifestSha256: plan.manifestSha256,
    },
    applicationInstrumentationEnabled: false,
    ...(plan.agent === "hermes" ? { agent: "hermes", stateRoot: plan.stateRoot } : {}),
    requestedIdleMs: 30000,
    observerWorkBoundMs: 40000,
    observerCleanupBoundMs: 5000,
    collectorInputs: [script, counter].map((file) => ({
      file: path.basename(file),
      sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    })),
    observation: observed,
    summary,
    qualificationClaim: false,
  };
  fs.writeFileSync(outputPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  return receipt;
}
