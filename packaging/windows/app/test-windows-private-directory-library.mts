// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateDirectoryDiagnosticCommand } from "./choice-inspect-diagnostics.mts";
import {
  SQLITE_PRIVATE_DIRECTORY_SOURCE,
  SQLITE_PRIVATE_DIRECTORY_LIBRARY,
  compilePrivateDirectoryRuntime,
  privateDirectoryNativeSource,
  privateDirectoryBuildCommand,
} from "./sqlite-private-directory-build.mts";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(process.argv[index + 1]);
}
const source = argument("--source-root");
const app = argument("--app-root");
const portable = process.argv.includes("--portable-proof");
if (!portable) {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64");
  assert.equal(process.versions.node, "22.23.2");
}
const original = fs.readFileSync(path.join(source, SQLITE_PRIVATE_DIRECTORY_SOURCE), "utf8");
const adapted = compilePrivateDirectoryRuntime(SQLITE_PRIVATE_DIRECTORY_SOURCE, original);
assert.equal(compilePrivateDirectoryRuntime("dist/unrelated.js", original), original);
assert.throws(
  () => compilePrivateDirectoryRuntime(SQLITE_PRIVATE_DIRECTORY_SOURCE, original + "\n"),
  /reviewed SQLite/,
);
assert.throws(() => privateDirectoryBuildCommand(original + "\n", "unused"), /reviewed SQLite/);

type DirectoryRuntime = {
  resolvePrivateDirectoryPowerShell(directory: string): { powershell: string; args: string[] };
  createPrivateSqliteDirectory(directory: string): Promise<void>;
  createPrivateSqliteDirectorySync(directory: string): void;
};
const powershell = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
function runtime(text: string, assetRoot = app): DirectoryRuntime {
  // Evaluate the pinned implementation, not a second implementation of its policy.
  // Only unrelated imports and system-program lookup are supplied by this harness.
  const start = text.indexOf("//#region src/infra/windows-powershell-spawn.ts");
  const end = text.indexOf("//#region src/infra/sqlite-readonly-location.ts");
  assert(start >= 0 && end > start);
  const moduleUrl = pathToFileURL(
    path.join(assetRoot, "node_modules/openclaw", SQLITE_PRIVATE_DIRECTORY_SOURCE),
  ).href;
  const body = text.slice(start, end).replaceAll("import.meta.url", JSON.stringify(moduleUrl));
  const factory = new Function(
    "path",
    "fs",
    "fs$1",
    "execFile",
    "execFileSync",
    "resolveSystemBin",
    "decodeWindowsOutputBuffer",
    "truncateUtf16Safe",
    "__nemoPrivateDirectoryFilePath",
    body +
      "\nreturn {resolvePrivateDirectoryPowerShell,createPrivateSqliteDirectory,createPrivateSqliteDirectorySync};",
  );
  return factory(
    path,
    fs,
    fs.promises,
    execFile,
    execFileSync,
    () => powershell,
    ({ buffer }: { buffer: Buffer }) => buffer.toString("utf8"),
    (text: string, limit: number) => text.slice(0, limit),
    fileURLToPath,
  ) as DirectoryRuntime;
}
const baseline = runtime(original);
const candidate = runtime(adapted);
const command = (value: { args: string[] }) =>
  Buffer.from(value.args.at(-1)!, "base64").toString("utf16le");
const unchangedPolicy = (script: string) =>
  script
    .split("; ")
    .filter(
      (part) =>
        !part.startsWith("$nativeSource =") &&
        !part.startsWith("$nativeLibrary =") &&
        !part.startsWith("Import-Module ") &&
        !part.startsWith("Add-Type "),
    )
    .join("; ");
for (const directory of ["plain", "spaces and 'quotes'", "[brackets]-é-雪"]) {
  const target = path.join(app, directory);
  const before = baseline.resolvePrivateDirectoryPowerShell(target);
  const after = candidate.resolvePrivateDirectoryPowerShell(target);
  assert.equal(before.powershell, after.powershell);
  assert.deepEqual(before.args.slice(0, -1), after.args.slice(0, -1));
  assert.equal(unchangedPolicy(command(after)), unchangedPolicy(command(before)));
  assert(privateDirectoryDiagnosticCommand(command(after)));
  assert.deepEqual(
    command(after)
      .split("; ")
      .filter((part) => part.startsWith("Import-Module ")),
    [
      "Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop",
    ],
  );
  assert(command(after).indexOf("Import-Module ") < command(after).indexOf("Add-Type "));
  assert.equal(
    command(after)
      .split("; ")
      .find((part) => part.startsWith("Add-Type ")),
    "Add-Type -LiteralPath $nativeLibrary",
  );
  const encoded = /\$nativeLibrary = [^;]*FromBase64String\('([^']+)'\)/u.exec(command(after));
  assert(encoded);
  assert.equal(
    Buffer.from(encoded[1], "base64").toString("utf8"),
    path.join(app, SQLITE_PRIVATE_DIRECTORY_LIBRARY),
  );
}
const buildCommand = privateDirectoryBuildCommand(
  original,
  path.join(app, SQLITE_PRIVATE_DIRECTORY_LIBRARY),
);
const encodedSource = /\$source = [^;]*FromBase64String\('([^']+)'\)/u.exec(buildCommand);
assert(encodedSource);
assert.equal(
  Buffer.from(encodedSource[1], "base64").toString("utf8"),
  privateDirectoryNativeSource(original).source,
);

if (portable) {
  console.log(
    JSON.stringify({
      passed: true,
      commandPolicyPreserved: true,
      hashDriftRejected: true,
      windowsQualified: false,
    }),
  );
} else {
  const library = path.join(app, SQLITE_PRIVATE_DIRECTORY_LIBRARY);
  assert(fs.statSync(library).isFile());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-library-controls-"));
  const priorModulePath = process.env.PSModulePath;
  try {
    // An ambient module with the same name must not supply the native helper's cmdlets.
    const modules = path.join(root, "ambient-modules");
    const shadow = path.join(modules, "Microsoft.PowerShell.Utility");
    fs.mkdirSync(shadow, { recursive: true });
    fs.writeFileSync(
      path.join(shadow, "Microsoft.PowerShell.Utility.psd1"),
      "@{ RootModule='Microsoft.PowerShell.Utility.psm1'; ModuleVersion='99.0.0'; FunctionsToExport=@('Add-Type','New-Object'); CmdletsToExport=@() }",
      { flag: "wx" },
    );
    fs.writeFileSync(
      path.join(shadow, "Microsoft.PowerShell.Utility.psm1"),
      "throw 'Ambient PowerShell utility module must not load.'",
      { flag: "wx" },
    );
    process.env.PSModulePath = modules;
    for (const variant of ["async", "sync"] as const) {
      const directory = path.join(root, variant + "-'[é]'");
      if (variant === "async") await candidate.createPrivateSqliteDirectory(directory);
      else candidate.createPrivateSqliteDirectorySync(directory);
      const marker = path.join(directory, "retained.txt");
      fs.writeFileSync(marker, "retained", { flag: "wx" });
      const encoded = Buffer.from(directory, "utf8").toString("base64");
      const inspect = [
        "$ErrorActionPreference = 'Stop'",
        // Node inherits pwsh's module paths; this child needs Windows PowerShell's modules.
        "$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')",
        `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
        "$acl = Get-Acl -LiteralPath $path",
        "$sid = [System.Security.Principal.SecurityIdentifier]",
        "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        "[pscustomobject]@{ owner=$acl.GetOwner($sid).Value; current=$current; protected=$acl.AreAccessRulesProtected; rules=@($acl.GetAccessRules($true,$true,$sid) | ForEach-Object { [pscustomobject]@{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq 'Allow');full=($_.FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl);inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags} }) } | ConvertTo-Json -Depth 4 -Compress",
      ].join("; ");
      const inspectAcl = () =>
        JSON.parse(
          execFileSync(
            powershell,
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(inspect, "utf16le").toString("base64"),
            ],
            { encoding: "utf8", timeout: 30_000, maxBuffer: 65_536, windowsHide: true },
          ).trim(),
        );
      const acl = inspectAcl();
      assert.equal(acl.owner, acl.current);
      assert.equal(acl.protected, true);
      assert.deepEqual(
        acl.rules.map((rule: { sid: string }) => rule.sid).sort(),
        [...new Set([acl.current, "S-1-5-18", "S-1-5-32-544"])].sort(),
      );
      for (const rule of acl.rules) {
        assert.equal(rule.allow, true);
        assert.equal(rule.full, true);
        assert.equal(rule.inheritance, 3);
        assert.equal(rule.propagation, 0);
      }
      if (variant === "async")
        await assert.rejects(candidate.createPrivateSqliteDirectory(directory), { code: "EEXIST" });
      else
        assert.throws(() => candidate.createPrivateSqliteDirectorySync(directory), {
          code: "EEXIST",
        });
      assert.equal(fs.readFileSync(marker, "utf8"), "retained");
      assert.deepEqual(inspectAcl(), acl);
    }
    // An absent library must not trigger runtime compilation or create staging state.
    const missing = runtime(adapted, path.join(root, "missing-runtime"));
    const absent = path.join(root, "must-not-exist");
    await assert.rejects(missing.createPrivateSqliteDirectory(absent), /Unable to create private/);
    assert.throws(
      () => missing.createPrivateSqliteDirectorySync(absent),
      /Unable to create private/,
    );
    assert.equal(fs.existsSync(absent), false);
  } finally {
    if (priorModulePath === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = priorModulePath;
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(root), false);
  console.log(
    JSON.stringify({
      passed: true,
      protectedDacl: true,
      existingTargetRefused: true,
      ambientModuleIgnored: true,
      asyncAndSync: true,
      cleanup: true,
      installedAcceptance: false,
    }),
  );
}
