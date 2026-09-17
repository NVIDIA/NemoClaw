#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// OpenClaw 2026.7.1 keeps the Node module graph on container restarts. Replace
// the process image after its native shutdown so updated ESM plugins reload.
// Remove when upstream container restart discards the previous module graph.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2026.7.1";
const MARKER = "// nemoclaw: reload sandbox plugins with a fresh process image";
// OpenShell's /proc reset wrapper can move the immutable launcher out of argv[0].
const OPENCLAW_LAUNCHER = "/usr/local/bin/openclaw";
const GATEWAY_ARGV_FILE = "windows-port-pids-jYst3qTE.js";
const ORIGINAL_GATEWAY_ARGV =
  "if (normalized.some((arg) => entryCandidates.some((entry) => arg.endsWith(entry)))) return true;";
const PATCHED_GATEWAY_ARGV = `if (normalized.some((arg) => entryCandidates.some((entry) => arg.endsWith(entry))) || normalized.includes(${JSON.stringify(OPENCLAW_LAUNCHER)})) return true;`;
const ORIGINAL = `\tif (isContainerEnvironment()) return {
\t\tmode: "disabled",
\t\tdetail: "container: use in-process restart to keep PID 1 alive"
\t};`;
// OpenShell sandboxes can omit Docker/Podman sentinels and namespace cgroup paths.
const REPLACEMENT = `\tif (isContainerEnvironment() || (process.platform === "linux" && process.env.OPENSHELL_SANDBOX === "1")) {
\t\t${MARKER}
\t\tif (process.platform === "linux" && process.env.OPENSHELL_SANDBOX === "1") {
\t\t\tif (typeof process.execve !== "function") throw new Error("OpenClaw sandbox restart requires process.execve");
\t\t\tprocess.execve(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], { ...process.env, ..._opts.env });
\t\t\tthrow new Error("OpenClaw sandbox process replacement unexpectedly returned");
\t\t}
\t\treturn {
\t\t\tmode: "disabled",
\t\t\tdetail: "container: use in-process restart to keep PID 1 alive"
\t\t};
\t}`;

export function patchContainerRestart(source: string): string {
  const matches = [
    ...source.matchAll(
      /function restartGatewayProcessWithFreshPid\(_opts = \{\}\) \{[\s\S]*?\n\}/gu,
    ),
  ];
  if (matches.length !== 1) throw new Error("Expected one native gateway restart function");
  const originalFunction = matches[0]![0];
  if (source.includes(MARKER)) {
    if (!originalFunction.includes(REPLACEMENT) || originalFunction.includes(ORIGINAL)) {
      throw new Error("Incomplete OpenClaw container restart patch");
    }
    return source;
  }
  if (originalFunction.split(ORIGINAL).length !== 2) {
    throw new Error("Unrecognized OpenClaw container restart boundary");
  }
  return source.replace(originalFunction, originalFunction.replace(ORIGINAL, REPLACEMENT));
}

export function patchOpenShellGatewayArgv(source: string): string {
  if (source.includes(PATCHED_GATEWAY_ARGV)) {
    if (source.includes(ORIGINAL_GATEWAY_ARGV)) {
      throw new Error("Incomplete OpenClaw OpenShell gateway argv patch");
    }
    return source;
  }
  if (source.split(ORIGINAL_GATEWAY_ARGV).length !== 2) {
    throw new Error("Unrecognized OpenClaw gateway argv boundary");
  }
  return source.replace(ORIGINAL_GATEWAY_ARGV, PATCHED_GATEWAY_ARGV);
}

export function patchOpenClawContainerRestart(distDir: string, audit = false): void {
  const metadata = JSON.parse(fs.readFileSync(path.join(distDir, "..", "package.json"), "utf8"));
  // The Dockerfile separately restricts these reviewed pins to legacy E2E fixtures.
  if (["2026.3.11", "2026.4.24"].includes(metadata.version)) return;
  if (metadata.version !== VERSION)
    throw new Error(`Unsupported OpenClaw version: ${metadata.version}`);
  const target = path.join(distDir, "cli", "gateway-lifecycle.runtime.js");
  const argvTarget = path.join(distDir, GATEWAY_ARGV_FILE);
  const source = fs.readFileSync(target, "utf8");
  const argvSource = fs.readFileSync(argvTarget, "utf8");
  const patched = patchContainerRestart(source);
  const argvPatched = patchOpenShellGatewayArgv(argvSource);
  if (audit) {
    if (patched !== source || argvPatched !== argvSource) {
      throw new Error("OpenClaw container restart patch is missing");
    }
  } else {
    if (patched !== source) fs.writeFileSync(target, patched);
    if (argvPatched !== argvSource) fs.writeFileSync(argvTarget, argvPatched);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const audit = args[0] === "--audit";
  const directory = args[audit ? 1 : 0];
  if (!directory || args.length !== (audit ? 2 : 1)) {
    console.error("Usage: patch-openclaw-container-restart.mts [--audit] <openclaw-dist-dir>");
    process.exitCode = 2;
  } else {
    try {
      patchOpenClawContainerRestart(directory, audit);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
