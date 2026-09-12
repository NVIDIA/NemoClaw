// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = process.argv[2];
const evidence = process.argv[3];
process.chdir(root);
const runner = require(path.join(root, "dist/lib/runner.js"));
const platform = require(path.join(root, "dist/lib/platform.js"));
const local = require(path.join(root, "dist/lib/inference/local.js"));
const { detectWindowsHostOllama } = require(
  path.join(root, "dist/lib/onboard/windows-host-ollama.js"),
);
const { detectInferenceProviderHostState } = require(
  path.join(root, "dist/lib/onboard/provider-host-state.js"),
);
const { buildInferenceProviderMenu } = require(
  path.join(root, "dist/lib/onboard/provider-menu.js"),
);
const snapshot =
  "$userHost = [Environment]::GetEnvironmentVariable('OLLAMA_HOST','User'); $watcherPath = Get-Process 'ollama app' -EA SilentlyContinue | Select-Object -First 1 -ExpandProperty Path; $daemonPath = Get-Process ollama -EA SilentlyContinue | Select-Object -First 1 -ExpandProperty Path; [PSCustomObject]@{userHost=$userHost;watcherPath=$watcherPath;daemonPath=$daemonPath} | ConvertTo-Json -Compress";
const queries = {
  process:
    "Get-Process ollama -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path",
  listener:
    "Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,OwningProcess | ConvertTo-Json -Compress",
  snapshot,
};
function record(result) {
  return {
    status: result.status,
    error: result.error?.message,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
  };
}
const report = {
  main: "e4e6391870bef3834cd30cdd997529e5361f89a5",
  desktopSetup: process.argv[4],
  platform: process.platform,
  arch: process.arch,
  powershell: {},
};
for (const [name, script] of Object.entries(queries)) {
  const command = ["powershell.exe", "-Command", script];
  report.powershell[name] = {
    inherited: record(
      spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: 15000 }),
    ),
    nemoclaw: record(
      runner.run(command, { ignoreError: true, suppressOutput: true, timeout: 15000 }),
    ),
  };
}
report.apiFromWsl = record(
  spawnSync(
    "curl",
    [
      "--noproxy",
      "*",
      "-sS",
      "--connect-timeout",
      "3",
      "--max-time",
      "10",
      "-w",
      "\nHTTP=%{http_code}\n",
      "http://host.docker.internal:11434/api/tags",
    ],
    { encoding: "utf8", timeout: 15000 },
  ),
);
report.docker = record(
  spawnSync("docker", ["info", "--format", "{{.OperatingSystem}}"], {
    encoding: "utf8",
    timeout: 15000,
  }),
);
report.windowsDetection = detectWindowsHostOllama();
report.windowsListener = platform.windowsProcessListensOnlyOnLoopback(runner.runCapture, {
  processName: "ollama",
  port: 11434,
  timeoutMs: 5000,
});
try {
  const state = detectInferenceProviderHostState({
    gpu: null,
    experimental: false,
    probeVllm: false,
  });
  report.state = state;
  const requirement = state.windowsHostOllamaDockerRequirement;
  report.menu = buildInferenceProviderMenu({
    remoteProviderConfig: {},
    agentProviderOptions: [],
    experimental: false,
    gpuNimCapable: false,
    ...state,
    ollamaPort: 11434,
    windowsHostLabelSuffix: requirement.labelSuffix ?? "",
    windowsHostInstallLabel: requirement.installLabel,
    windowsHostStartLabel: requirement.startLabel,
    ollamaInstallEntry: state.ollamaInstallMenu.entry,
    routedEnabled: false,
  });
  report.routeProtection = local.probeWindowsHostOllamaRouteProtection();
} catch (error) {
  report.discoveryError = error.stack;
}
try {
  const captured = JSON.parse(report.powershell.snapshot.nemoclaw.stdout);
  const malformedOptionalPath = [captured.watcherPath, captured.daemonPath].some(
    (value) => value !== null && typeof value !== "string",
  );
  if (malformedOptionalPath) {
    const windows = require(path.join(root, "dist/lib/inference/ollama/windows.js"));
    const outcome = windows.setupWindowsOllamaLoopbackBinding({ announceStop: true });
    report.windowsSetupOutcome = { ok: outcome.ok, reason: outcome.reason };
    if (outcome.ok) outcome.rollback();
    else windows.printWindowsOllamaSnapshotDiagnostics();
  }
} catch (error) {
  report.snapshotProbeError = error.message;
}
fs.writeFileSync(path.join(evidence, "main-discovery.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
const stageProgram = `process.chdir(${JSON.stringify(root)}); process.env.NEMOCLAW_AGENT='hermes'; const {setupNim}=require(${JSON.stringify(path.join(root, "dist/lib/onboard.js"))}); const {loadAgent}=require(${JSON.stringify(path.join(root, "dist/lib/agent/defs.js"))}); Promise.resolve(setupNim(null,null,loadAgent('hermes'))).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.stack); process.exitCode=1;});`;
fs.writeFileSync(path.join(evidence, "provider-stage.cjs"), stageProgram);
const py = `import pexpect,sys
child=pexpect.spawn('node',[sys.argv[1]],encoding='utf-8',timeout=120)
with open(sys.argv[2],'w') as log:
 child.logfile=log
 try:
  child.expect('Select your inference provider:')
  child.expect('Enter your choice', timeout=10)
 except (pexpect.TIMEOUT,pexpect.EOF):
  pass
 finally:
  child.close(force=True)
`;
const stage = spawnSync(
  "python3",
  ["-c", py, path.join(evidence, "provider-stage.cjs"), path.join(evidence, "provider-menu.log")],
  { encoding: "utf8", timeout: 150000 },
);
console.log("Provider stage:", record(stage));
