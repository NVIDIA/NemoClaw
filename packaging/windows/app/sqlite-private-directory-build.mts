// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const SQLITE_PRIVATE_DIRECTORY_SOURCE = "dist/sqlite-readonly-location-BC9PgENz.js";
export const SQLITE_PRIVATE_DIRECTORY_LIBRARY =
  "node_modules/openclaw/dist/nemoclaw-sqlite-private-directory.dll";
const sourceSha256 = "51b2e9d5e354d2f61546c87d90ae719f1d794545e06a5d9b944c03306a84808c";
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export function privateDirectoryNativeSource(text: string) {
  if (digest(text) !== sourceSha256)
    throw new Error("The reviewed SQLite private-directory source changed.");
  const declaration = /const WINDOWS_PRIVATE_DIRECTORY_NATIVE_SOURCE = `([^`]*)`;/u.exec(text);
  if (!declaration || declaration[1].includes("${"))
    throw new Error("The SQLite private-directory native source is unavailable.");
  return { declaration: declaration[0], source: declaration[1] };
}

export function compilePrivateDirectoryRuntime(relative: string, text: string) {
  if (relative !== SQLITE_PRIVATE_DIRECTORY_SOURCE) return text;
  const native = privateDirectoryNativeSource(text);
  // Keep the upstream script's owner, protected DACL, atomic creation and errors.
  // Compile native code in CI and load its PowerShell cmdlets from the OS module.
  const replacements = [
    [native.declaration, ""],
    [
      'const encodedNativeSource = Buffer.from(WINDOWS_PRIVATE_DIRECTORY_NATIVE_SOURCE, "utf8").toString("base64");',
      'const encodedNativeLibrary = Buffer.from(__nemoPrivateDirectoryFilePath(new URL("./nemoclaw-sqlite-private-directory.dll", import.meta.url)), "utf8").toString("base64");',
    ],
    [
      "`$nativeSource = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedNativeSource}'))`",
      "`$nativeLibrary = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedNativeLibrary}'))`",
    ],
    [
      '"Add-Type -TypeDefinition $nativeSource -Language CSharp"',
      `"Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop",\n\t\t"Add-Type -LiteralPath $nativeLibrary"`,
    ],
  ];
  for (const [before, after] of replacements) {
    if (text.split(before).length !== 2)
      throw new Error("The SQLite private-directory compilation boundary changed.");
    text = text.replace(before, after);
  }
  return 'import { fileURLToPath as __nemoPrivateDirectoryFilePath } from "node:url";\n' + text;
}

export function privateDirectoryBuildCommand(text: string, output: string) {
  const native = privateDirectoryNativeSource(text);
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
  return [
    "$ErrorActionPreference = 'Stop'",
    `if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) { throw 'Windows PowerShell 5 is required for the packaged library.' }`,
    `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(native.source)}'))`,
    `$output = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(output)}'))`,
    "if (Test-Path -LiteralPath $output) { throw 'The private-directory library output already exists.' }",
    "Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $output -OutputType Library",
  ].join("; ");
}

export function buildPrivateDirectoryLibrary(source: string, app: string) {
  const text = fs.readFileSync(path.join(source, SQLITE_PRIVATE_DIRECTORY_SOURCE), "utf8");
  const native = privateDirectoryNativeSource(text);
  if (process.platform !== "win32")
    return {
      built: false,
      reason: "Portable proof does not compile or qualify the Windows library.",
    };
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot))
    throw new Error(
      "The Windows system directory is required to compile the private-directory library.",
    );
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const output = path.join(app, SQLITE_PRIVATE_DIRECTORY_LIBRARY);
  if (fs.existsSync(output)) throw new Error("The private-directory library output must be fresh.");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  // This process runs only during compilation, before the resource inventory is sealed.
  execFileSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(privateDirectoryBuildCommand(text, output), "utf16le").toString("base64"),
    ],
    { timeout: 60_000, maxBuffer: 65_536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  return {
    built: true,
    path: SQLITE_PRIVATE_DIRECTORY_LIBRARY,
    sourceSha256,
    nativeSourceSha256: digest(native.source),
    ...privateDirectoryLibraryIdentity(output),
    runtimeCompilation: false,
    windowsQualified: false,
  };
}

export function privateDirectoryLibraryIdentity(output: string) {
  const descriptor = fs.openSync(output, "r");
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(output, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.size === 0n ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    )
      throw new Error("The compiled private-directory library is not an ordinary nonempty file.");
    const bytes = fs.readFileSync(descriptor);
    if (BigInt(bytes.length) !== opened.size)
      throw new Error("The compiled private-directory library changed size while reading.");
    return { sha256: digest(bytes), bytes: bytes.length };
  } finally {
    fs.closeSync(descriptor);
  }
}
