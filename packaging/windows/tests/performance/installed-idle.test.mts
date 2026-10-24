// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { once } from "node:events";
import { test } from "node:test";
import {
  collectIdleObserver,
  summarizeIdle,
  validateIdlePlan,
  type IdlePlan,
} from "./installed-idle.mts";
const plan: IdlePlan = {
  installRoot: "C:\\Program Files\\NVIDIA\\NemoClaw",
  guardianPid: 100,
  hostPid: 101,
  guardianStartedUtc: "2026-09-10T22:00:00.1234567Z",
  hostStartedUtc: "2026-09-10T22:00:00.2345678Z",
  runtimeId: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  sourceRevision: "c".repeat(40),
};
const roleNames = [
  "guardian",
  "host-runtime",
  "openshell-gateway",
  "native-window",
  "ui-relay",
  "inference-relay",
  "mxc-executor",
  "contained-node",
  "observer",
];
function fixture() {
  const before = roleNames.map((role, index) => ({
    role,
    processId: 100 + index,
    executable: "C:\\owned\\" + role + ".exe",
    creationFileTime: "12345678901234567",
    capturedTicks: "1000000",
    kernel100ns: "10000",
    user100ns: "20000",
    readOperations: "9007199254740993",
    writeOperations: "3",
    otherOperations: "5",
    readTransferBytes: "9007199254740997",
    writeTransferBytes: "13",
    otherTransferBytes: "17",
  }));
  const after = structuredClone(before).map((row) => ({
    ...row,
    capturedTicks: "4000000",
    kernel100ns: "110000",
    user100ns: "220000",
    readOperations: "9007199254740995",
    readTransferBytes: "9007199254741004",
  }));
  return {
    kind: "complete" as const,
    schemaVersion: 1 as const,
    ...plan,
    frequency: "100000",
    requestedIdleMs: 30000,
    clock: "Stopwatch.GetTimestamp",
    logicalProcessors: 4,
    preparationMs: 100,
    observerTotalMs: 30200,
    frames: [
      { processes: before, captureTicks: "10" },
      { processes: after, captureTicks: "20" },
    ],
    applicationInstrumentationEnabled: false as const,
    scenario: "settled-response-browser-connected-no-user-actions",
    relayCounters: null,
  };
}
test("plan binds the caller and fixed30s interval, rejecting unsafe IDs and extra authority", () => {
  const value = validateIdlePlan(plan);
  assert.equal(value.controllerPid, process.pid);
  assert.equal(value.durationMs, 30000);
  for (const change of [
    { guardianPid: 0 },
    { hostPid: 100 },
    { hostStartedUtc: "yesterday" },
    { installRoot: "C:\\owned\\..\\foreign" },
    { command: "arbitrary" },
  ])
    assert.throws(() => validateIdlePlan({ ...plan, ...change }));
});
test("large I/O deltas remain exact and observer costs are separate", () => {
  const summary = summarizeIdle(fixture(), plan);
  assert.equal(summary.targets.length, 8);
  assert.equal(summary.observer?.role, "observer");
  assert.equal(summary.targets[0].counters.readOperations, "2");
  assert.equal(summary.targets[0].counters.readTransferBytes, "7");
  assert.equal(summary.targets[0].cpuMs, 30);
  assert.equal(summary.targets[0].elapsedMs, 30000);
  assert.equal(summary.observerCaptureMs, 0.3);
  assert.equal(summary.modelLatencyMs, null);
  assert.equal(summary.relayCounters, null);
});
for (const [name, mutate] of [
  [
    "reused PID",
    (x: ReturnType<typeof fixture>) => {
      x.frames[1].processes[0].creationFileTime = "999";
    },
  ],
  [
    "changed process",
    (x: ReturnType<typeof fixture>) => {
      x.frames[1].processes[0].processId++;
    },
  ],
  [
    "wrong image",
    (x: ReturnType<typeof fixture>) => {
      x.frames[1].processes[0].executable = "C:\\foreign.exe";
    },
  ],
  [
    "counter rollback",
    (x: ReturnType<typeof fixture>) => {
      x.frames[1].processes[0].kernel100ns = "1";
    },
  ],
  [
    "short interval",
    (x: ReturnType<typeof fixture>) => {
      x.frames[1].processes[0].capturedTicks = "2000000";
    },
  ],
  [
    "duplicate role",
    (x: ReturnType<typeof fixture>) => {
      x.frames[1].processes[0].role = "observer";
    },
  ],
  [
    "out-of-range integer",
    (x: ReturnType<typeof fixture>) => {
      x.frames[1].processes[0].writeOperations = "18446744073709551616";
    },
  ],
  [
    "foreign runtime",
    (x: ReturnType<typeof fixture>) => {
      x.runtimeId = "e".repeat(64);
    },
  ],
] as const)
  test("rejects " + name, () => {
    const value = fixture();
    mutate(value);
    assert.throws(() => summarizeIdle(value, plan));
  });
function child(source: string) {
  return spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}
test("actual separate process emits bounded complete-line observer protocol and exits", async () => {
  const observer = child(
    `const start=process.cpuUsage(); console.log(JSON.stringify({kind:'ready',schemaVersion:1,processId:process.pid})); setTimeout(()=>{ console.log(JSON.stringify({kind:'complete',schemaVersion:1,processId:process.pid,cpu:process.cpuUsage(start)})); },40);`,
  );
  const result = await collectIdleObserver(observer, 3000, 1000);
  assert.equal(result.failure, null);
  assert.equal(result.observerExitConfirmed, true);
  assert.equal(result.records[1].processId, observer.pid);
  // Transport control only; these are not invented Windows role/counter samples.
});
test("observer timeout ends only the owned observer, leaving a separate real process alive", async () => {
  const unrelated = child("setInterval(()=>{},1000)");
  try {
    const observer = child("setInterval(()=>{},1000)");
    const result = await collectIdleObserver(observer, 100, 1000);
    assert.match(result.failure!, /deadline/u);
    assert.equal(result.observerExitConfirmed, true);
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.killed, false);
  } finally {
    const closed = once(unrelated, "close");
    unrelated.kill();
    await closed;
  }
});
test("partial records and excessive output fail with the real observer stopped", async () => {
  for (const source of [
    `process.stdout.write('{"kind":"ready"');`,
    `process.stdout.write('x'.repeat(140000));setInterval(()=>{},1000);`,
  ]) {
    const result = await collectIdleObserver(child(source), 3000, 1000);
    assert(result.failure);
    assert.equal(result.observerExitConfirmed, true);
  }
});

function hermesFixture() {
  const value = fixture();
  const install = plan.installRoot;
  const root = install + "\\runtimes\\" + plan.runtimeId + "\\hermes";
  const entries = [
    ["guardian", install + "\\bin\\NemoClaw.exe", 0],
    [
      "host-runtime",
      install + "\\runtimes\\" + plan.runtimeId + "\\app\\NemoClaw.Runtime.exe",
      100,
    ],
    ["openshell-gateway", install + "\\bin\\openshell-gateway.exe", 101],
    ["native-window", install + "\\native-ui\\NemoClaw.Bootstrapper.exe", 101],
    ["hermes-ui-relay", install + "\\bin\\NemoClaw.exe", 101],
    ["hermes-broker-relay", install + "\\bin\\NemoClaw.exe", 101],
    ["hermes-status-owner", install + "\\bin\\NemoClaw.exe", 101],
    ["hermes-state-session-owner", install + "\\bin\\NemoClaw.exe", 101],
    ["hermes-runtime-session-owner", install + "\\bin\\NemoClaw.exe", 101],
    ["mxc-executor", root + "\\mxc-compat\\wxc-exec.exe", 102],
    ["hermes-launcher", root + "\\mxc-compat\\NemoClawMsysLauncher.exe", 109],
    ["contained-node", install + "\\bin\\node.exe", 110],
    ["observer", "C:\\Program Files\\PowerShell\\7\\pwsh.exe", 0],
    ["hermes-python-redirector-113", root + "\\hermes-agent\\venv\\Scripts\\python.exe", 111],
    [
      "hermes-python-114",
      root +
        "\\hermes-agent\\.hermes-runtime\\python\\cpython-3.11.16-windows-aarch64-none\\python.exe",
      113,
    ],
    ["hermes-contained-node-115", install + "\\bin\\node.exe", 114],
  ] as const;
  const frames = value.frames.map((frame) => ({
    ...frame,
    processes: entries.map(([role, executable], index) => ({
      ...frame.processes[0],
      role,
      executable,
      processId: 100 + index,
    })),
  }));
  const checked = {
    ...plan,
    agent: "hermes" as const,
    stateRoot: "C:\\NemoClawState-S-1-5-21-1-2-3-1001-hermes",
    windowsRoot: "C:\\Windows",
  };
  return {
    checked,
    result: {
      ...value,
      ...checked,
      frames,
      processRelations: entries.flatMap(([, executable, parentProcessId], index) =>
        parentProcessId && index > 1
          ? [
              {
                processId: 100 + index,
                parentProcessId,
                executable,
                creationFileTime: frames[0].processes[index].creationFileTime,
                parentCreationFileTime: frames[0].processes.find(
                  (row) => row.processId === parentProcessId,
                )!.creationFileTime,
              },
            ]
          : [],
      ),
    },
  };
}

test("Hermes idle plan and summary retain its sealed executor and real Python counters", () => {
  const { checked, result } = hermesFixture();
  assert.equal(validateIdlePlan(checked).agent, "hermes");
  const summary = summarizeIdle(result, checked);
  const python = summary.targets.find((row) => row.role === "hermes-python-114")!;
  assert.equal(python.cpuMs, 30);
  assert.equal(python.counters.readOperations, "2");
  assert.equal(python.counters.readTransferBytes, "7");
  assert(
    summary.targets
      .find((row) => row.role === "mxc-executor")!
      .executable.includes("\\hermes\\mxc-compat\\"),
  );
  assert.equal(summary.targets.length, 15);
  assert.equal(
    summary.targets.find((row) => row.role === "hermes-contained-node-115")!.executable,
    summary.targets.find((row) => row.role === "contained-node")!.executable,
  );
  assert.throws(() =>
    validateIdlePlan({ ...checked, stateRoot: "D:\\NemoClawState-S-1-5-21-1-2-3-1001-hermes" }),
  );
});

test("Hermes idle rejects stock MXC, absent Python, foreign images and broken parent generations", () => {
  for (const kind of [
    "stock-executor",
    "missing-python",
    "foreign-python",
    "outside-contained-chain",
    "parent-generation",
    "pid-reuse",
    "outside-node-chain",
    "foreign-node",
    "missing-launcher",
    "reordered-anchors",
    "short-node-sample",
  ]) {
    const { checked, result } = hermesFixture();
    if (kind === "stock-executor")
      for (const frame of result.frames)
        frame.processes.find((row) => row.role === "mxc-executor")!.executable =
          checked.installRoot + "\\mxc\\wxc-exec.exe";
    if (kind === "missing-python")
      for (const frame of result.frames)
        frame.processes = frame.processes.filter((row) => row.role !== "hermes-python-114");
    if (kind === "foreign-python")
      for (const frame of result.frames)
        frame.processes.find((row) => row.role === "hermes-python-114")!.executable =
          "C:\\HostPython\\python.exe";
    const edge = result.processRelations.find((row) => row.processId === 114)!;
    if (kind === "outside-contained-chain") edge.parentProcessId = 101;
    if (kind === "parent-generation") edge.parentCreationFileTime = "1";
    if (kind === "pid-reuse")
      result.frames[1].processes.find((row) => row.processId === 114)!.creationFileTime = "999";
    if (kind === "outside-node-chain")
      result.processRelations.find((row) => row.processId === 115)!.parentProcessId = 101;
    if (kind === "foreign-node")
      for (const frame of result.frames)
        frame.processes.find((row) => row.processId === 115)!.executable = "C:\\HostNode\\node.exe";
    if (kind === "missing-launcher")
      for (const frame of result.frames)
        frame.processes = frame.processes.filter((row) => row.role !== "hermes-launcher");
    if (kind === "reordered-anchors")
      result.processRelations.find((row) => row.processId === 111)!.parentProcessId = 109;
    if (kind === "short-node-sample")
      result.frames[1].processes.find((row) => row.processId === 115)!.capturedTicks = "2000000";
    assert.throws(() => summarizeIdle(result, checked), kind);
  }
});

test(
  "actual PowerShell selector separates same-image descendants and rejects ambiguous roots",
  {
    skip: !process.env.NEMOCLAW_TEST_PWSH && process.platform !== "win32",
  },
  () => {
    const source = fs.readFileSync(new URL("./sample-installed-idle.ps1", import.meta.url), "utf8");
    const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
    const install = plan.installRoot;
    const runtime = install + "\\runtimes\\" + plan.runtimeId + "\\hermes";
    const gateway = {
      ProcessId: 1,
      ParentProcessId: 0,
      ExecutablePath: install + "\\bin\\openshell-gateway.exe",
    };
    const executor = {
      ProcessId: 2,
      ParentProcessId: 1,
      ExecutablePath: runtime + "\\mxc-compat\\wxc-exec.exe",
    };
    const launcher = {
      ProcessId: 3,
      ParentProcessId: 2,
      ExecutablePath: runtime + "\\mxc-compat\\NemoClawMsysLauncher.exe",
    };
    const worker = {
      ProcessId: 4,
      ParentProcessId: 3,
      ExecutablePath: install + "\\bin\\node.exe",
    };
    const python = {
      ProcessId: 5,
      ParentProcessId: 4,
      ExecutablePath: runtime + "\\hermes-agent\\venv\\Scripts\\python.exe",
    };
    const nested = { ProcessId: 6, ParentProcessId: 5, ExecutablePath: worker.ExecutablePath };
    const candidate = { row: worker, chain: [gateway, executor, launcher] };
    const descendant = { row: nested, chain: [gateway, executor, launcher, worker, python] };
    const cases = [
      { guests: [candidate, descendant], accepted: true },
      { guests: [candidate, { ...candidate, row: { ...worker, ProcessId: 7 } }], accepted: false },
      { guests: [descendant], accepted: false },
      { guests: [{ ...candidate, chain: [gateway, launcher, executor] }], accepted: false },
      { guests: [{ ...candidate, chain: [gateway, launcher] }], accepted: false },
      {
        guests: [{ ...candidate, row: { ...worker, ExecutablePath: "C:\\Foreign\\node.exe" } }],
        accepted: false,
      },
      { guests: [{ ...candidate, row: { ...worker, ParentProcessId: 1 } }], accepted: false },
      {
        guests: [{ ...candidate, chain: [{ ...gateway, ProcessId: 8 }, executor, launcher] }],
        accepted: false,
      },
    ];
    // Load only the production pure selector functions. Never execute the sampler,
    // its CI guard, CIM discovery, native counters or process-handle operations.
    const script = `
$ErrorActionPreference='Stop'
$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(source)}'))
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Sampler parse failed'}
foreach($name in @('Require','Same-Path','One','Hermes-Worker')) {
  $functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true))
  if($functions.Count -ne 1){throw 'Selector function missing or ambiguous'}
  Invoke-Expression $functions[0].Extent.Text
}
$cases=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(JSON.stringify(cases))}')) | ConvertFrom-Json
$count=0
foreach($case in $cases) {
  $accepted=$false; $selected=$null
  try { $selected=Hermes-Worker $case.guests '${worker.ExecutablePath}' '${launcher.ExecutablePath}' '${executor.ExecutablePath}' 1; $accepted=$true } catch {}
  if($accepted -ne $case.accepted){throw 'Wrong worker selection result'}
  if($accepted -and $selected.row.ProcessId -ne 4){throw 'Nested Node selected as worker'}
  $count++
}
[Console]::WriteLine($count)
`;
    const result = spawnSync(
      process.env.NEMOCLAW_TEST_PWSH ?? "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))",
      ],
      { input: script, encoding: "utf8", timeout: 10000, maxBuffer: 128 * 1024 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), String(cases.length));
  },
);
