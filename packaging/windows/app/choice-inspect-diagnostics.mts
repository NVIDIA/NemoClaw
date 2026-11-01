// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Inject only into the synthetic inspect process, after its package-manager trap.
// Do not propagate a preload to workers or change their arguments or environment.
export const choiceInspectChildDiagnostics = String.raw`
(() => {
  const cp = require("node:child_process");
  const started = performance.now();
  let sequence = 0, records = 0;
  const emit = (id, method, category, stage) => {
    if (records++ >= 128) return;
    try {
      process.stderr.write("[nemoclaw-choice-child] " + JSON.stringify({
        id, method, category, stage, elapsedMs: Math.round(performance.now() - started)
      }) + "\n");
    } catch {}
  };
  for (const method of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
    const original = cp[method];
    cp[method] = function(...args) {
      const id = ++sequence;
      const executable = typeof args[0] === "string" ? args[0] : "";
      const category = executable === process.execPath
        ? (Array.isArray(args[1]) && args[1].includes("--openclaw-sqlite-readonly-child")
          ? "node-sqlite-readonly" : "node")
        : /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(executable)
          ? "powershell" : "other";
      emit(id, method, category, "start");
      try {
        const result = original.apply(this, args);
        if (method.endsWith("Sync")) emit(id, method, category, "returned");
        else result.once("close", () => emit(id, method, category, "closed"));
        return result;
      } catch (error) {
        emit(id, method, category, "threw");
        throw error;
      }
    };
  }
  require("node:module").syncBuiltinESMExports();
})();
`;

// Only the separate, synthetic readonly-worker probe loads this preload.
// Acceptance workers keep their original arguments and environment.
export function privateDirectoryDiagnosticCommand(command: string): string | null {
  const phases = [
    ["library-loaded", "Add-Type -LiteralPath $nativeLibrary"],
    ["identity-read", "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User"],
    ["acl-built", "$sddl = $security.GetSecurityDescriptorSddlForm($sections)"],
    ["directory-created", "$errorCode = [OpenClawPrivateDirectory]::Create($path, $sddl)"],
  ];
  const commands = command.split("; ");
  if (phases.some(([, statement]) => commands.filter((part) => part === statement).length !== 1))
    return null;
  const mark = (stage: string) =>
    `[Console]::Error.WriteLine('[nemoclaw-private-directory] {"stage":"${stage}","elapsedMs":' + $nemoPrivateDirectoryTimer.ElapsedMilliseconds + '}')`;
  const traced = commands.flatMap((statement) => {
    const phase = phases.find(([, expected]) => expected === statement);
    return phase ? [statement, mark(phase[0])] : [statement];
  });
  return [
    "$nemoPrivateDirectoryTimer = [Diagnostics.Stopwatch]::StartNew()",
    mark("script-start"),
    ...traced,
  ].join("; ");
}

export const sqliteReadonlyWorkerDiagnostics =
  choiceInspectChildDiagnostics +
  `
(() => {
  const instrument = ${privateDirectoryDiagnosticCommand.toString()};
  const cp = require("node:child_process"), original = cp.execFile;
  const started = performance.now();
  cp.execFile = function(...args) {
    const executable = typeof args[0] === "string" ? args[0] : "";
    const argv = args[1];
    if (!/(?:^|[\\\\/])powershell(?:\\.exe)?$/i.test(executable) || !Array.isArray(argv) ||
        argv.length !== 5 || argv[0] !== "-NoLogo" || argv[1] !== "-NoProfile" ||
        argv[2] !== "-NonInteractive" || argv[3] !== "-EncodedCommand" || typeof argv[4] !== "string")
      return original.apply(this, args);
    const command = instrument(Buffer.from(argv[4], "base64").toString("utf16le"));
    if (command === null) return original.apply(this, args);
    const child = original.apply(this, [args[0], [...argv.slice(0, 4), Buffer.from(command, "utf16le").toString("base64")], ...args.slice(2)]);
    let pending = "", bytes = 0, records = 0;
    child.stderr.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 65536) return;
      pending += chunk.toString("utf8");
      const lines = pending.split(/\\r?\\n/u);
      pending = lines.pop();
      for (const line of lines) {
        if (records >= 5 || !/^\\[nemoclaw-private-directory\\] \\{"stage":"(?:script-start|library-loaded|identity-read|acl-built|directory-created)","elapsedMs":[0-9]{1,8}\\}$/u.test(line)) continue;
        records++;
        process.stderr.write(line.slice(0, -1) + ',"observedAtMs":' + Math.round(performance.now() - started) + '}\\n');
      }
    });
    return child;
  };
  require("node:module").syncBuiltinESMExports();
})();
` +
  String.raw`
(() => {
  const sqlite = require("node:sqlite"), original = sqlite.backup;
  const started = performance.now();
  let records = 0;
  const mark = stage => {
    if (records++ >= 128) return;
    try {
      process.stderr.write("[nemoclaw-snapshot-backup] " + JSON.stringify({
        stage, elapsedMs: Math.round(performance.now() - started)
      }) + "\n");
    } catch {}
  };
  mark("preload-started");
  sqlite.backup = function(...args) {
    mark("start");
    let result;
    try { result = original.apply(this, args); }
    catch (error) { mark("threw"); throw error; }
    result.then(() => mark("finished"), () => mark("rejected"));
    return result;
  };
  require("node:module").syncBuiltinESMExports();
})();
`;
