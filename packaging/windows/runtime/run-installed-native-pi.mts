// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readOpenedRegularFile, writeNativeGatewayConfig } from "./native-security.mts";
import { waitForNativeMxcCompletion } from "./native-ui-lifecycle.mts";

import {
  allowlistedWindowsEnvironment,
  argumentValue,
  freePort,
  jsonContainsExactValue,
  quoteYamlPath,
  removeDirectory,
  requiredDirectory,
  requiredFile,
  run,
  sanitizedDiagnostic,
  stopChild,
  waitForPort,
} from "./run-installed-native-turn.mts";

const PI_TURN_PROOFS = [
  ["Reply exactly with NATIVE_PI_TURN_1_OK", "NATIVE_PI_TURN_1_OK"],
  ["Reply exactly with NATIVE_PI_TURN_2_OK", "NATIVE_PI_TURN_2_OK"],
  ["Reply exactly with NATIVE_PI_TURN_3_OK", "NATIVE_PI_TURN_3_OK"],
];

const HERMES_TURN_PROOFS = [
  ["Reply exactly with NATIVE_HERMES_TURN_1_OK", "NATIVE_HERMES_TURN_1_OK"],
  ["Reply exactly with NATIVE_HERMES_TURN_2_OK", "NATIVE_HERMES_TURN_2_OK"],
  ["Reply exactly with NATIVE_HERMES_TURN_3_OK", "NATIVE_HERMES_TURN_3_OK"],
];

const DEEP_AGENTS_TURN_PROOFS = [
  ["Reply exactly with NATIVE_DEEP_AGENTS_TURN_1_OK", "NATIVE_DEEP_AGENTS_TURN_1_OK"],
  ["Reply exactly with NATIVE_DEEP_AGENTS_TURN_2_OK", "NATIVE_DEEP_AGENTS_TURN_2_OK"],
  ["Reply exactly with NATIVE_DEEP_AGENTS_TURN_3_OK", "NATIVE_DEEP_AGENTS_TURN_3_OK"],
];

function fail(message) {
  throw new Error(`Native Windows terminal-agent qualification failed: ${message}`);
}

async function waitForTerminalAgentResult(
  resultPath,
  finalToken,
  create,
  gateway,
  createFailure,
  agentLabel,
  timeout = 360_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (createFailure.error !== null) throw createFailure.error;
    if (create.signalCode !== null || (create.exitCode !== null && create.exitCode !== 0))
      fail(
        `OpenShell request exited ${create.exitCode ?? create.signalCode ?? "unknown"} before ${agentLabel} finished`,
      );
    if (gateway.exitCode !== null || gateway.signalCode !== null)
      fail(`The native gateway stopped before ${agentLabel} completed`);
    const result = readOpenedRegularFile(resultPath, {
      encoding: "utf8",
      maxBytes: 1024 * 1024,
    });
    if (result !== null && result.includes(finalToken)) return result;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))),
    );
  }
  fail(`${agentLabel} did not publish its bounded result receipt before the deadline`);
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function createPrivateShareRoot(directory, systemRoot) {
  const powershell = requiredFile(
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "Windows PowerShell",
  );
  const script = String.raw`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
public static class NativeShareAccess {
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct Request {
    public uint Access; public IntPtr Self; public IntPtr Types; public uint TypeCount; public IntPtr Arguments;
  }
  [StructLayout(LayoutKind.Sequential)] struct Reply {
    public uint Count; public IntPtr Granted; public IntPtr Sacl; public IntPtr Error;
  }
  [DllImport("authz.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool AuthzInitializeResourceManager(uint flags, IntPtr check, IntPtr groups, IntPtr free, string name, out IntPtr manager);
  [DllImport("authz.dll", SetLastError = true)]
  static extern bool AuthzInitializeContextFromSid(uint flags, byte[] sid, IntPtr manager, IntPtr expiration, Luid id, IntPtr arguments, out IntPtr context);
  [DllImport("authz.dll", SetLastError = true)]
  static extern bool AuthzAccessCheck(uint flags, IntPtr context, ref Request request, IntPtr audit, byte[] descriptor, IntPtr descriptors, uint count, ref Reply reply, IntPtr results);
  [DllImport("authz.dll")] static extern bool AuthzFreeContext(IntPtr context);
  [DllImport("authz.dll")] static extern bool AuthzFreeResourceManager(IntPtr manager);
  public static uint Granted(byte[] descriptor, byte[] sid) {
    IntPtr manager = IntPtr.Zero, context = IntPtr.Zero;
    IntPtr replyBuffer = Marshal.AllocHGlobal(12);
    IntPtr granted = replyBuffer, sacl = IntPtr.Add(replyBuffer, 4), error = IntPtr.Add(replyBuffer, 8);
    try {
      Marshal.WriteInt32(granted, 0); Marshal.WriteInt32(sacl, 0); Marshal.WriteInt32(error, 0);
      // NO_AUDIT avoids requiring SeAuditPrivilege; SKIP_TOKEN_GROUPS prevents account lookup.
      if (!AuthzInitializeResourceManager(1, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, "NemoClaw share ACL", out manager))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!AuthzInitializeContextFromSid(2, sid, manager, IntPtr.Zero, new Luid(), IntPtr.Zero, out context))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      Request request = new Request { Access = 0x02000000 }; // MAXIMUM_ALLOWED
      Reply reply = new Reply { Count = 1, Granted = granted, Sacl = sacl, Error = error };
      if (!AuthzAccessCheck(0, context, ref request, IntPtr.Zero, descriptor, IntPtr.Zero, 0, ref reply, IntPtr.Zero))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      int result = Marshal.ReadInt32(error);
      if (result != 0 && result != 5) throw new Win32Exception(result);
      return unchecked((uint)Marshal.ReadInt32(granted));
    } finally {
      if (context != IntPtr.Zero) AuthzFreeContext(context);
      if (manager != IntPtr.Zero) AuthzFreeResourceManager(manager);
      Marshal.FreeHGlobal(replyBuffer);
    }
  }
}
'@
$target = $env:NEMOCLAW_NATIVE_SHARE_ROOT
if ([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)) { throw 'Private share root already exists.' }
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @(@($owner.Value, 'S-1-5-18') | Select-Object -Unique)
$security = [Security.AccessControl.DirectorySecurity]::new()
$security.SetOwner($owner)
$security.SetAccessRuleProtection($true, $false)
foreach ($value in $allowed) {
  $sid = [Security.Principal.SecurityIdentifier]::new($value)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $security.AddAccessRule($rule)
}
# Apply the protected DACL during creation, before any offload, home, or temp data exists.
[void][IO.Directory]::CreateDirectory($target, $security)
$actual = Get-Acl -LiteralPath $target
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) {
  throw 'Private share owner or inheritance differs from the required DACL.'
}
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne $allowed.Count -or @($rules | Where-Object {
  $_.IsInherited -or $_.IdentityReference.Value -notin $allowed -or $_.AccessControlType -ne 'Allow' -or
  $_.FileSystemRights -ne 'FullControl' -or $_.InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or $_.PropagationFlags -ne 'None'
}).Count -ne 0) { throw 'Private share DACL contains an unexpected access grant.' }
$descriptor = $actual.GetSecurityDescriptorBinaryForm()
foreach ($value in $allowed) {
  $sid = [Security.Principal.SecurityIdentifier]::new($value)
  $bytes = New-Object byte[] $sid.BinaryLength
  $sid.GetBinaryForm($bytes, 0)
  if (([NativeShareAccess]::Granted($descriptor, $bytes) -band 7) -ne 7) { throw 'Required host identity cannot access the private share.' }
}
$denied = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
foreach ($value in $denied) {
  $sid = [Security.Principal.SecurityIdentifier]::new($value)
  $bytes = New-Object byte[] $sid.BinaryLength
  $sid.GetBinaryForm($bytes, 0)
  if (([NativeShareAccess]::Granted($descriptor, $bytes) -band 7) -ne 0) { throw 'An unprivileged identity can access the private share.' }
}
@{ ownerSid = $owner.Value; serviceSid = 'S-1-5-18'; protected = $true; nonOwnerDataAccess = $false; deniedSids = $denied } | ConvertTo-Json -Compress
`;
  const result = await run(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    allowlistedWindowsEnvironment({ NEMOCLAW_NATIVE_SHARE_ROOT: directory }),
    "Creating and checking the private native-agent share",
    60_000,
  );
  return JSON.parse(result.stdout);
}

function deepAgentDiagnosticFiles(root) {
  const matches = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (
        entry.isFile() &&
        (entry.name === "deepagents-debug.log" ||
          /^deepagents_server_log_.*[.]txt$/u.test(entry.name))
      )
        matches.push(candidate);
    }
  }
  return matches;
}

function piWorkloadSource() {
  return String.raw`import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};
const home = required("NEMOCLAW_PI_HOME");
const piCli = required("NEMOCLAW_PI_ENTRY");
const modelPort = Number(required("NEMOCLAW_PI_MODEL_PORT"));
const resultPath = required("NEMOCLAW_PI_RESULT");
const turnProofs = [
  ["Reply exactly with NATIVE_PI_TURN_1_OK", "NATIVE_PI_TURN_1_OK"],
  ["Reply exactly with NATIVE_PI_TURN_2_OK", "NATIVE_PI_TURN_2_OK"],
  ["Reply exactly with NATIVE_PI_TURN_3_OK", "NATIVE_PI_TURN_3_OK"],
];
const bodyText = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};
const messageText = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join(" ");
};
const model = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "native-preview", object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  const body = JSON.parse(await bodyText(request));
  const prompt = (body.messages ?? []).map((entry) => messageText(entry?.content)).join("\n");
  const expected = turnProofs.find(([, token]) => prompt.includes(token))?.[1] ?? "NATIVE_PI_OK";
  const id = "chatcmpl-nemoclaw-native-pi";
  const created = Math.floor(Date.now() / 1000);
  if (body.stream === true) {
    response.writeHead(200, { "cache-control": "no-cache", connection: "keep-alive", "content-type": "text/event-stream" });
    for (const chunk of [
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: { content: expected }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]) response.write("data: " + JSON.stringify(chunk) + "\n\n");
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model: "native-preview",
    choices: [{ index: 0, message: { role: "assistant", content: expected }, finish_reason: "stop" }],
  }));
});
await new Promise((resolve, reject) => {
  model.once("error", reject);
  model.listen(modelPort, "127.0.0.1", resolve);
});
const agentDirectory = join(home, ".pi", "agent");
mkdirSync(agentDirectory, { recursive: true });
writeFileSync(join(agentDirectory, "models.json"), JSON.stringify({
  defaultModel: "native-preview",
  providers: {
    openshell: {
      api: "openai-completions",
      apiKey: "qualification-only",
      baseUrl: "http://127.0.0.1:" + modelPort + "/v1",
      models: [{
        id: "native-preview",
        name: "NemoClaw Native Pi Preview",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 4096,
      }],
    },
  },
}), "utf8");
writeFileSync(join(agentDirectory, "settings.json"), JSON.stringify({
  defaultProvider: "openshell",
  defaultModel: "native-preview",
  defaultThinkingLevel: "off",
  enableInstallTelemetry: false,
  enableAnalytics: false,
  quietStartup: true,
}), "utf8");

const execute = (prompt) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    piCli,
    "--no-approve",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--thinking", "off",
    "--provider", "openshell",
    "--model", "native-preview",
    "--print", prompt,
  ], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      LOCALAPPDATA: home,
      NODE_DISABLE_COMPILE_CACHE: "1",
      PI_CODING_AGENT_DIR: agentDirectory,
      USERPROFILE: home,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    process.stderr.write(chunk);
  });
  child.once("error", reject);
  child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error("Pi exited " + code + ": " + stderr)));
});

const turns = [];
try {
  for (let index = 0; index < turnProofs.length; index += 1) {
    const [prompt, expected] = turnProofs[index];
    console.log("PI> TURN " + (index + 1) + " running through the real Pi CLI");
    const result = await execute(prompt);
    const output = result.stdout.trim();
    if (!output.includes(expected)) throw new Error("Pi output did not contain exact token " + expected);
    console.log("PI> TURN " + (index + 1) + " PASS " + expected);
    turns.push({ prompt, expected, output });
  }
  writeFileSync(resultPath, JSON.stringify({
    schemaVersion: 1,
    classification: "native-windows-pi-agent-result",
    piVersion: "0.84.1",
    turnCount: turns.length,
    turns,
    verdict: "pass",
  }, null, 2) + "\n", "utf8");
} finally {
  await new Promise((resolve) => model.close(() => resolve()));
}
`;
}

function hermesWorkloadSource() {
  return String.raw`import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};
const home = required("NEMOCLAW_HERMES_HOME_ROOT");
const hermesHome = join(home, ".hermes");
const python = required("NEMOCLAW_HERMES_PYTHON");
const sitePackages = required("NEMOCLAW_HERMES_SITE_PACKAGES");
const modelPort = Number(required("NEMOCLAW_HERMES_MODEL_PORT"));
const resultPath = required("NEMOCLAW_HERMES_RESULT");
const turnProofs = [
  ["Reply exactly with NATIVE_HERMES_TURN_1_OK", "NATIVE_HERMES_TURN_1_OK"],
  ["Reply exactly with NATIVE_HERMES_TURN_2_OK", "NATIVE_HERMES_TURN_2_OK"],
  ["Reply exactly with NATIVE_HERMES_TURN_3_OK", "NATIVE_HERMES_TURN_3_OK"],
];
const bodyText = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};
const messageText = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join(" ");
};
const model = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "native-preview", object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  const body = JSON.parse(await bodyText(request));
  const prompt = (body.messages ?? []).map((entry) => messageText(entry?.content)).join("\n");
  const expected = turnProofs.find(([, token]) => prompt.includes(token))?.[1] ?? "NATIVE_HERMES_OK";
  const id = "chatcmpl-nemoclaw-native-hermes";
  const created = Math.floor(Date.now() / 1000);
  if (body.stream === true) {
    response.writeHead(200, { "cache-control": "no-cache", connection: "keep-alive", "content-type": "text/event-stream" });
    for (const chunk of [
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: { content: expected }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]) response.write("data: " + JSON.stringify(chunk) + "\n\n");
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model: "native-preview",
    choices: [{ index: 0, message: { role: "assistant", content: expected }, finish_reason: "stop" }],
  }));
});
await new Promise((resolve, reject) => {
  model.once("error", reject);
  model.listen(modelPort, "127.0.0.1", resolve);
});
mkdirSync(hermesHome, { recursive: true });
writeFileSync(join(hermesHome, "config.yaml"), [
  "model:",
  "  default: native-preview",
  "  provider: custom",
  "  base_url: http://127.0.0.1:" + modelPort + "/v1",
  "  api_key: sk-native-qualification",
  "  context_length: 131072",
  "agent:",
  "  max_turns: 3",
  "memory:",
  "  memory_enabled: false",
  "  user_profile_enabled: false",
  "display:",
  "  compact: true",
  "  show_reasoning: false",
  "updates:",
  "  pre_update_backup: false",
  "  refresh_cua_driver: false",
  "",
].join("\n"), "utf8");
writeFileSync(join(hermesHome, ".env"), "\n", "utf8");
const runner = join(home, "run-hermes.py");
writeFileSync(runner, [
  "import os",
  "import sys",
  "sys.path.insert(0, os.environ['NEMOCLAW_HERMES_SITE_PACKAGES'])",
  "from io import BytesIO",
  "from PIL import Image, ImageShow",
  "from python_multipart.multipart import parse_form, parse_options_header",
  "if len(Image.new('RGB', (2, 2)).tobytes()) != 12:",
  "    raise RuntimeError('Native Pillow image operation failed')",
  "try:",
  "    ImageShow.WindowsViewer().get_command(chr(34))",
  "except ValueError:",
  "    pass",
  "else:",
  "    raise RuntimeError('Pillow accepted an invalid Windows filename')",
  "try:",
  "    parse_form({'Content-Type': b'application/octet-stream', 'Content-Length': b'-1'}, BytesIO(b'bounded'), lambda _: None, lambda _: None)",
  "except ValueError as error:",
  "    if 'Content-Length must be non-negative' not in str(error):",
  "        raise",
  "else:",
  "    raise RuntimeError('Multipart accepted a negative content length')",
  "header = b'form-data; name=plain; name*=utf-8' + bytes([39, 39]) + b'other'",
  "if parse_options_header(header)[1] != {b'name': b'plain'}:",
  "    raise RuntimeError('Multipart accepted an extended parameter override')",
  "from hermes_cli.main import main",
  "main()",
  "",
].join("\n"), "utf8");

const execute = (prompt) => new Promise((resolve, reject) => {
  const child = spawn(python, [
    runner,
    "--oneshot", prompt,
    "--provider", "custom",
    "--model", "native-preview",
  ], {
    cwd: home,
    env: {
      ...process.env,
      HERMES_HOME: hermesHome,
      HOME: home,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
      USERPROFILE: home,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    process.stderr.write(chunk);
  });
  child.once("error", reject);
  child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error("Hermes exited " + code + ": " + stderr)));
});

const turns = [];
try {
  for (let index = 0; index < turnProofs.length; index += 1) {
    const [prompt, expected] = turnProofs[index];
    console.log("HERMES> TURN " + (index + 1) + " running through the real Hermes CLI");
    const result = await execute(prompt);
    const output = result.stdout.trim();
    if (!output.includes(expected)) throw new Error("Hermes output did not contain exact token " + expected);
    console.log("HERMES> TURN " + (index + 1) + " PASS " + expected);
    turns.push({ prompt, expected, output });
  }
  writeFileSync(resultPath, JSON.stringify({
    schemaVersion: 1,
    classification: "native-windows-hermes-agent-result",
    hermesVersion: "0.19.0",
    nativePythonSecurityChecksPassed: true,
    turnCount: turns.length,
    turns,
    verdict: "pass",
  }, null, 2) + "\n", "utf8");
} finally {
  await new Promise((resolve) => model.close(() => resolve()));
}
`;
}

function deepAgentsWorkloadSource() {
  return String.raw`import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};
const home = required("NEMOCLAW_DEEP_AGENTS_HOME_ROOT");
const python = required("NEMOCLAW_DEEP_AGENTS_PYTHON");
const sitePackages = required("NEMOCLAW_DEEP_AGENTS_SITE_PACKAGES");
const modelPort = Number(required("NEMOCLAW_DEEP_AGENTS_MODEL_PORT"));
const resultPath = required("NEMOCLAW_DEEP_AGENTS_RESULT");
const turnProofs = [
  ["Reply exactly with NATIVE_DEEP_AGENTS_TURN_1_OK", "NATIVE_DEEP_AGENTS_TURN_1_OK"],
  ["Reply exactly with NATIVE_DEEP_AGENTS_TURN_2_OK", "NATIVE_DEEP_AGENTS_TURN_2_OK"],
  ["Reply exactly with NATIVE_DEEP_AGENTS_TURN_3_OK", "NATIVE_DEEP_AGENTS_TURN_3_OK"],
];
const bodyText = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};
const messageText = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join(" ");
};
const model = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "native-preview", object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  const body = JSON.parse(await bodyText(request));
  const prompt = (body.messages ?? []).map((entry) => messageText(entry?.content)).join("\n");
  const expected = turnProofs.find(([, token]) => prompt.includes(token))?.[1] ?? "NATIVE_DEEP_AGENTS_OK";
  const id = "chatcmpl-nemoclaw-native-deep-agents";
  const created = Math.floor(Date.now() / 1000);
  if (body.stream === true) {
    response.writeHead(200, { "cache-control": "no-cache", connection: "keep-alive", "content-type": "text/event-stream" });
    for (const chunk of [
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: { content: expected }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]) response.write("data: " + JSON.stringify(chunk) + "\n\n");
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model: "native-preview",
    choices: [{ index: 0, message: { role: "assistant", content: expected }, finish_reason: "stop" }],
  }));
});
await new Promise((resolve, reject) => {
  model.once("error", reject);
  model.listen(modelPort, "127.0.0.1", resolve);
});
const configDirectory = join(home, ".deepagents");
mkdirSync(join(configDirectory, ".state"), { recursive: true });
mkdirSync(join(configDirectory, "skills"), { recursive: true });
writeFileSync(join(configDirectory, "config.toml"), [
  "# Generated by NemoClaw native Windows qualification.",
  "[models]",
  "default = \"openai:native-preview\"",
  "",
  "[models.providers.openai]",
  "models = [\"native-preview\"]",
  "api_key_env = \"DEEPAGENTS_CODE_OPENAI_API_KEY\"",
  "base_url = \"http://127.0.0.1:" + modelPort + "/v1\"",
  "enabled = true",
  "",
  "[models.providers.openai.params]",
  "use_responses_api = false",
  "",
  "[update]",
  "check = false",
  "auto_update = false",
  "",
  "[warnings]",
  "suppress = [\"ripgrep\", \"tavily\"]",
  "",
].join("\n"), "utf8");
const runner = join(home, "run-deep-agents.py");
// Python 3.13 gives tempfile.mkdtemp() a protected owner-only Windows DACL.
// MXC child processes need the approved writable-root capability to inherit.
const deepAgentsTempfileShim = [
  "import tempfile",
  "def _nemoclaw_mkdtemp(suffix=None, prefix=None, dir=None):",
  "    suffix = '' if suffix is None else suffix",
  "    prefix = tempfile.template if prefix is None else prefix",
  "    parent = tempfile.gettempdir() if dir is None else dir",
  "    for _ in range(tempfile.TMP_MAX):",
  "        candidate = os.path.join(parent, prefix + os.urandom(16).hex() + suffix)",
  "        sys.audit('tempfile.mkdtemp', candidate)",
  "        try:",
  "            os.mkdir(candidate, 0o777)",
  "        except FileExistsError:",
  "            continue",
  "        return os.path.abspath(candidate)",
  "    raise FileExistsError('No usable temporary directory name found')",
  "tempfile.mkdtemp = _nemoclaw_mkdtemp",
];
writeFileSync(runner, [
  "import os",
  "import sys",
  ...deepAgentsTempfileShim,
  "sys.path.insert(0, os.environ['NEMOCLAW_DEEP_AGENTS_SITE_PACKAGES'])",
  "from deepagents_code import cli_main",
  "cli_main()",
  "",
].join("\n"), "utf8");

const execute = (prompt) => new Promise((resolve, reject) => {
  const child = spawn(python, [
    runner,
    "--non-interactive", prompt,
    "--quiet",
    "--sandbox", "none",
  ], {
    cwd: home,
    env: {
      ...process.env,
      DEEPAGENTS_CODE_OPENAI_API_KEY: "qualification-only",
      HOME: home,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
      USERPROFILE: home,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    process.stderr.write(chunk);
  });
  child.once("error", reject);
  child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error("Deep Agents Code exited " + code + ": " + stderr)));
});

const turns = [];
try {
  for (let index = 0; index < turnProofs.length; index += 1) {
    const [prompt, expected] = turnProofs[index];
    console.log("DEEP AGENTS> TURN " + (index + 1) + " running through the real Deep Agents Code CLI");
    const result = await execute(prompt);
    const output = result.stdout.trim();
    if (!output.includes(expected)) throw new Error("Deep Agents output did not contain exact token " + expected);
    console.log("DEEP AGENTS> TURN " + (index + 1) + " PASS " + expected);
    turns.push({ prompt, expected, output });
  }
  writeFileSync(resultPath, JSON.stringify({
    schemaVersion: 1,
    classification: "native-windows-deep-agents-code-result",
    deepAgentsCodeVersion: "0.1.55",
    turnCount: turns.length,
    turns,
    verdict: "pass",
  }, null, 2) + "\n", "utf8");
} finally {
  await new Promise((resolve) => model.close(() => resolve()));
}
`;
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "arm64")
    fail("native Windows ARM64 is required");
  if (!process.argv.includes("--qualification"))
    fail("the current terminal-agent entrypoint requires a completed graphical configuration");
  const agentId = argumentValue("--agent") ?? "pi";
  if (agentId !== "pi" && agentId !== "hermes" && agentId !== "langchain-deepagents-code")
    fail(`unsupported terminal agent: ${agentId}`);
  const isHermes = agentId === "hermes";
  const isDeepAgents = agentId === "langchain-deepagents-code";
  const agentLabel = isHermes ? "Hermes" : isDeepAgents ? "Deep Agents Code" : "Pi";
  const sandboxPrefix = isHermes ? "nc-h" : isDeepAgents ? "nc-d" : "nc-pi";
  const agentVersion = isHermes ? "0.19.0" : isDeepAgents ? "0.1.55" : "0.84.1";
  const turnProofs = isHermes
    ? HERMES_TURN_PROOFS
    : isDeepAgents
      ? DEEP_AGENTS_TURN_PROOFS
      : PI_TURN_PROOFS;
  const finalToken = turnProofs[2][1];

  const installRoot = requiredDirectory(
    process.env.NEMOCLAW_NATIVE_INSTALL_ROOT ?? "",
    "NemoClaw installation root",
  );
  const binRoot = requiredDirectory(path.join(installRoot, "bin"), "NemoClaw bin directory");
  const installedNode = requiredFile(path.join(binRoot, "node.exe"), "Node.js runtime");
  const openshell = requiredFile(path.join(binRoot, "openshell.exe"), "OpenShell CLI");
  const gatewayExecutable = requiredFile(
    path.join(binRoot, "openshell-gateway.exe"),
    "OpenShell gateway",
  );
  const installedAgentRoot = requiredDirectory(
    path.join(installRoot, isHermes ? "hermes" : isDeepAgents ? "deepagents" : "pi"),
    `${agentLabel} runtime`,
  );
  const installedPythonRoot =
    isHermes || isDeepAgents
      ? requiredDirectory(path.join(installRoot, "python"), "Python runtime")
      : null;
  const installedAgentEntrypoint = requiredFile(
    isHermes
      ? path.join(installedAgentRoot, "site-packages", "hermes_cli", "main.py")
      : isDeepAgents
        ? path.join(installedAgentRoot, "site-packages", "deepagents_code", "main.py")
        : path.join(
            installedAgentRoot,
            "node_modules",
            "@earendil-works",
            "pi-coding-agent",
            "dist",
            "cli.js",
          ),
    `${agentLabel} installed entrypoint`,
  );
  requiredFile(path.join(installRoot, "config", "mxc-gateway.toml"), "MXC gateway configuration");
  requiredFile(path.join(installRoot, "mxc", "wxc-exec.exe"), "MXC executor");

  const systemDrive = process.env.SystemDrive;
  if (!systemDrive || !/^[A-Za-z]:$/u.test(systemDrive)) fail("SystemDrive is invalid");
  const systemRoot = requiredDirectory(process.env.SystemRoot ?? "", "Windows system root");
  const runId = randomBytes(5).toString("hex");
  const runRoot = path.join(`${systemDrive}\\`, `NemoClawNativeAgent-${agentId}-${runId}`);
  const shareRoot = path.join(`${systemDrive}\\`, `NemoClawNativeAgentShare-${agentId}-${runId}`);
  const runtimeRoot = path.join(
    `${systemDrive}\\`,
    `NemoClawNativeAgentRuntime-${agentId}-${runId}`,
  );
  for (const directory of [runRoot, runtimeRoot]) {
    if (fs.existsSync(directory)) fail("qualification root already exists");
    fs.mkdirSync(directory);
  }
  const gatewayConfig = writeNativeGatewayConfig(installRoot, runRoot);
  // MXC adds its container-specific grant from filesystem_policy after this host boundary is set.
  const privateShareAcl = await createPrivateShareRoot(shareRoot, systemRoot);
  const evidenceRoot = path.resolve(
    argumentValue("--artifact-directory") ??
      path.join(process.env.LOCALAPPDATA ?? runRoot, "NVIDIA", "NemoClaw", "evidence", agentId),
  );
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const node = path.join(runtimeRoot, "node.exe");
  fs.copyFileSync(installedNode, node);
  const stagedAgentRoot = path.join(runtimeRoot, isDeepAgents ? "deepagents" : agentId);
  fs.cpSync(installedAgentRoot, stagedAgentRoot, { recursive: true });
  let agentEnvironment;
  let workloadText;
  if (isHermes || isDeepAgents) {
    const stagedPythonRoot = path.join(runtimeRoot, "python");
    fs.cpSync(installedPythonRoot, stagedPythonRoot, { recursive: true });
    fs.writeFileSync(
      path.join(stagedPythonRoot, "python313._pth"),
      [
        "python313.zip",
        ".",
        path.relative(stagedPythonRoot, path.join(stagedAgentRoot, "site-packages")),
        "import site",
        "",
      ].join("\r\n"),
      "ascii",
    );
    if (isDeepAgents) {
      agentEnvironment = {
        DEEPAGENTS_CODE_DEBUG: "1",
        DEEPAGENTS_CODE_DEBUG_FILE: path.join(shareRoot, "deepagents-debug.log"),
        DEEPAGENTS_CODE_RIPGREP_INSTALLER: "system",
        NEMOCLAW_DEEP_AGENTS_HOME_ROOT: path.join(shareRoot, "home"),
        NEMOCLAW_DEEP_AGENTS_MODEL_PORT: "",
        NEMOCLAW_DEEP_AGENTS_PYTHON: requiredFile(
          path.join(stagedPythonRoot, "python.exe"),
          "staged Python runtime",
        ),
        NEMOCLAW_DEEP_AGENTS_RESULT: path.join(shareRoot, "deep-agents-result.json"),
        NEMOCLAW_DEEP_AGENTS_SITE_PACKAGES: requiredDirectory(
          path.join(stagedAgentRoot, "site-packages"),
          "staged Deep Agents Code site-packages",
        ),
      };
      workloadText = deepAgentsWorkloadSource();
    } else {
      agentEnvironment = {
        NEMOCLAW_HERMES_HOME_ROOT: path.join(shareRoot, "home"),
        NEMOCLAW_HERMES_MODEL_PORT: "",
        NEMOCLAW_HERMES_PYTHON: requiredFile(
          path.join(stagedPythonRoot, "python.exe"),
          "staged Python runtime",
        ),
        NEMOCLAW_HERMES_RESULT: path.join(shareRoot, "hermes-result.json"),
        NEMOCLAW_HERMES_SITE_PACKAGES: requiredDirectory(
          path.join(stagedAgentRoot, "site-packages"),
          "staged Hermes site-packages",
        ),
      };
      workloadText = hermesWorkloadSource();
    }
  } else {
    agentEnvironment = {
      NEMOCLAW_PI_ENTRY: requiredFile(
        path.join(
          stagedAgentRoot,
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "cli.js",
        ),
        "staged Pi CLI",
      ),
      NEMOCLAW_PI_HOME: path.join(shareRoot, "home"),
      NEMOCLAW_PI_MODEL_PORT: "",
      NEMOCLAW_PI_RESULT: path.join(shareRoot, "pi-result.json"),
    };
    workloadText = piWorkloadSource();
  }
  const workload = path.join(shareRoot, `${agentId}-native-qualification.mjs`);
  fs.writeFileSync(workload, workloadText, "utf8");
  const resultPath = isHermes
    ? agentEnvironment.NEMOCLAW_HERMES_RESULT
    : isDeepAgents
      ? agentEnvironment.NEMOCLAW_DEEP_AGENTS_RESULT
      : agentEnvironment.NEMOCLAW_PI_RESULT;
  const policyPath = path.join(runRoot, "policy.yaml");
  fs.writeFileSync(
    policyPath,
    [
      "version: 1",
      "",
      "filesystem_policy:",
      "  include_workdir: false",
      "  read_only:",
      `    - ${quoteYamlPath(runtimeRoot)}`,
      "  read_write:",
      `    - ${quoteYamlPath(shareRoot)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  const configRoot = path.join(runRoot, "config");
  const stateRoot = path.join(runRoot, "state");
  const home = path.join(shareRoot, "home");
  const temp = path.join(shareRoot, "temp");
  for (const directory of [configRoot, stateRoot, home, temp])
    fs.mkdirSync(directory, { recursive: true });
  const openShellPort = await freePort();
  const modelPort = await freePort();
  if (isHermes) agentEnvironment.NEMOCLAW_HERMES_MODEL_PORT = String(modelPort);
  else if (isDeepAgents) agentEnvironment.NEMOCLAW_DEEP_AGENTS_MODEL_PORT = String(modelPort);
  else agentEnvironment.NEMOCLAW_PI_MODEL_PORT = String(modelPort);
  const sandboxName = `${sandboxPrefix}-${runId}`;
  const gatewayName = `nemoclaw-${agentId}-${runId}`;
  const gatewayLogPath = path.join(runRoot, "openshell-gateway.log");
  const gatewayErrorPath = path.join(runRoot, "openshell-gateway.err.log");
  const gatewayLog = fs.openSync(gatewayLogPath, "w");
  const gatewayError = fs.openSync(gatewayErrorPath, "w");
  const gatewayEnvironment = allowlistedWindowsEnvironment({
    OPENSHELL_DRIVERS: "mxc",
    OPENSHELL_GATEWAY_CONFIG: gatewayConfig,
    XDG_CONFIG_HOME: configRoot,
    XDG_STATE_HOME: stateRoot,
  });
  const gateway = spawn(
    gatewayExecutable,
    [
      "--port",
      String(openShellPort),
      "--disable-tls",
      "--db-url",
      "sqlite::memory:",
      "--log-level",
      "info",
    ],
    {
      env: gatewayEnvironment,
      stdio: ["ignore", gatewayLog, gatewayError],
      windowsHide: true,
    },
  );
  let cliEnvironment = gatewayEnvironment;
  let create = null;
  let createOutput = "";
  let createError = "";
  let passed = false;
  let logsClosed = false;
  try {
    console.log(`${agentLabel.toUpperCase()}> Starting the installed OpenShell MXC gateway`);
    await waitForPort(openShellPort, gateway);
    cliEnvironment = allowlistedWindowsEnvironment({
      ...gatewayEnvironment,
      OPENSHELL_GATEWAY: undefined,
    });
    await run(
      openshell,
      ["gateway", "add", `http://127.0.0.1:${openShellPort}`, "--local", "--name", gatewayName],
      cliEnvironment,
      `Registering the native ${agentLabel} gateway`,
    );
    await run(
      openshell,
      ["gateway", "select", gatewayName],
      cliEnvironment,
      `Selecting the native ${agentLabel} gateway`,
    );
    const sandboxEnvironment = {
      HOME: home,
      LOCALAPPDATA: home,
      ...agentEnvironment,
      NODE_DISABLE_COMPILE_CACHE: "1",
      NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS ?? "1",
      OS: "Windows_NT",
      PATH: `${path.join(systemRoot, "System32")};${systemRoot}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PROCESSOR_ARCHITECTURE: "ARM64",
      SYSTEMDRIVE: systemDrive,
      SYSTEMROOT: systemRoot,
      TEMP: temp,
      TMP: temp,
      USERPROFILE: home,
      WINDIR: systemRoot,
    };
    const createArgs = [
      "sandbox",
      "create",
      "--name",
      sandboxName,
      "--policy",
      policyPath,
      "--driver-config-json",
      JSON.stringify({ mxc: { command: [node, workload], cwd: shareRoot, windows_ui: true } }),
      "--no-tty",
    ];
    for (const [name, value] of Object.entries(sandboxEnvironment))
      createArgs.push("--env", `${name}=${value}`);
    console.log(
      `${agentLabel.toUpperCase()}> Launching the real ${agentLabel} runtime inside native MXC`,
    );
    create = spawn(openshell, createArgs, {
      env: cliEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    create.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      createOutput = `${createOutput}${text}`.slice(-128 * 1024);
      process.stdout.write(text);
    });
    create.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      createError = `${createError}${text}`.slice(-128 * 1024);
      process.stderr.write(text);
    });
    const createFailure = { error: null };
    create.once("error", (error) => {
      createFailure.error = error;
    });
    const agentResultText = await waitForTerminalAgentResult(
      resultPath,
      finalToken,
      create,
      gateway,
      createFailure,
      agentLabel,
    );
    const agentResult = JSON.parse(agentResultText);
    const reportedVersion = isHermes
      ? agentResult.hermesVersion
      : isDeepAgents
        ? agentResult.deepAgentsCodeVersion
        : agentResult.piVersion;
    if (
      agentResult.verdict !== "pass" ||
      reportedVersion !== agentVersion ||
      (isHermes && agentResult.nativePythonSecurityChecksPassed !== true) ||
      agentResult.turnCount !== 3 ||
      !turnProofs.every(([, expected], index) => agentResult.turns?.[index]?.expected === expected)
    )
      fail(`${agentLabel} result receipt is incomplete`);
    const completion = await waitForNativeMxcCompletion(
      openshell,
      cliEnvironment,
      sandboxName,
      gateway,
      null,
    );
    if (completion === "ExecFailed")
      fail(`The native ${agentLabel} executor failed during cleanup`);
    await run(
      openshell,
      ["sandbox", "delete", sandboxName],
      cliEnvironment,
      `Deleting the native ${agentLabel} sandbox`,
    );
    if (create !== null && !(await stopChild(create)))
      fail(`${agentLabel} sandbox request watcher did not stop`);
    const sandboxList = await run(
      openshell,
      ["sandbox", "list", "-o", "json"],
      cliEnvironment,
      `Verifying native ${agentLabel} sandbox cleanup`,
    );
    if (jsonContainsExactValue(JSON.parse(sandboxList.stdout.trim()), sandboxName))
      fail(`${agentLabel} sandbox remained registered after deletion`);
    if (!(await stopChild(gateway))) fail("OpenShell MXC gateway did not stop");
    fs.closeSync(gatewayLog);
    fs.closeSync(gatewayError);
    logsClosed = true;
    for (const directory of [runRoot, runtimeRoot]) {
      if (!(await removeDirectory(directory)))
        fail(`runtime root remained: ${path.basename(directory)}`);
    }
    const receipt = {
      ...agentResult,
      classification: `installed-nemoclaw-native-windows-${agentId}`,
      architecture: "arm64",
      backend: "process_container",
      interface: `${agentLabel} terminal one-shot mode`,
      runtimeEntrypointSha256: sha256(installedAgentEntrypoint),
      runtimeHostSha256: sha256(
        installedPythonRoot === null
          ? installedNode
          : requiredFile(path.join(installedPythonRoot, "python.exe"), "installed Python runtime"),
      ),
      deterministicLocalModel: true,
      privateShareAcl,
      createWatcherStopped: true,
      sandboxDeleted: true,
      sandboxRegistryAbsent: true,
      gatewayStopped: true,
      qualificationRootsRemoved: true,
    };
    fs.writeFileSync(
      path.join(evidenceRoot, `native-windows-${agentId}-${runId}.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
    await removeDirectory(shareRoot);
    passed = true;
    console.log(
      `${agentLabel.toUpperCase()}> PASS three real ${agentLabel} agent turns inside native MXC`,
    );
  } finally {
    if (create !== null) await stopChild(create);
    if (!passed) {
      try {
        await run(
          openshell,
          ["sandbox", "delete", sandboxName],
          cliEnvironment,
          `Failure cleanup native ${agentLabel} sandbox`,
          30_000,
        );
      } catch {}
    }
    await stopChild(gateway);
    if (!logsClosed) {
      fs.closeSync(gatewayLog);
      fs.closeSync(gatewayError);
    }
    if (!passed) {
      const diagnosticParts = [createOutput, createError];
      for (const file of [gatewayLogPath, gatewayErrorPath]) {
        const content = readOpenedRegularFile(file, {
          encoding: "utf8",
          maxBytes: 2 * 1024 * 1024,
        });
        if (content !== null) diagnosticParts.push(content);
      }
      if (isDeepAgents) {
        for (const file of deepAgentDiagnosticFiles(shareRoot)) {
          const content = readOpenedRegularFile(file, {
            encoding: "utf8",
            maxBytes: 2 * 1024 * 1024,
          });
          if (content !== null) diagnosticParts.push(content.slice(-512 * 1024));
        }
      }
      const diagnostic = sanitizedDiagnostic(diagnosticParts.filter(Boolean).join("\n"), [
        [installRoot, "<install-root>"],
        [runtimeRoot, "<runtime-root>"],
        [shareRoot, "<share-root>"],
        [runRoot, "<run-root>"],
      ]);
      if (diagnostic) {
        fs.writeFileSync(
          path.join(evidenceRoot, `native-windows-${agentId}-diagnostic-${runId}.log`),
          diagnostic,
          "utf8",
        );
        console.error(`${agentLabel.toUpperCase()}> Sanitized failure diagnostic\n${diagnostic}`);
      }
    }
    for (const directory of [runRoot, shareRoot, runtimeRoot]) await removeDirectory(directory);
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Native Windows terminal-agent qualification failed.",
  );
  process.exitCode = 1;
});
