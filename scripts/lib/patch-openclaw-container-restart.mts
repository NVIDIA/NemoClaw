#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// OpenClaw 2026.9.1 retains native ESM modules during in-process restarts.
// Keep native restart admission and shutdown, then refresh the process image
// inside the same OpenShell sandbox. Remove when upstream container restart
// reliably reloads changed plugin modules and their dependencies.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2026.9.1";
const MARKER = "// nemoclaw: reload sandbox plugins with a fresh process image";
const ORIGINAL = `\treturn {
\t\tmode: "disabled",
\t\tdetail: process.platform === "win32" ? "win32: detached respawn unsupported without Scheduled Task markers" : isContainerEnvironment() ? "container: use in-process restart to keep PID 1 alive" : "unmanaged: use in-process restart to keep custom supervisor PID tracking stable"
\t};`;
const REPLACEMENT = `\t${MARKER}
\tif (process.platform === "linux" && process.env.OPENSHELL_SANDBOX === "1") {
\t\tif (typeof process.execve !== "function") throw new Error("OpenClaw sandbox restart requires process.execve");
\t\t// OpenShell Node bootstrap arguments are single-use; replay only application argv.
\t\tprocess.execve(process.execPath, process.argv, { ...process.env, ..._opts.env });
\t\tthrow new Error("OpenClaw sandbox process replacement unexpectedly returned");
\t}
${ORIGINAL}`;

export function patchContainerRestart(source: string): string {
  const matches = [
    ...source.matchAll(
      /function restartGatewayProcessWithFreshPid\(_opts = \{\}\) \{[\s\S]*?\n\}/gu,
    ),
  ];
  if (matches.length !== 1) throw new Error("Expected one native gateway restart function");
  const originalFunction = matches[0]![0];
  if (source.includes(MARKER)) {
    if (
      source.split(MARKER).length !== 2 ||
      originalFunction.split(REPLACEMENT).length !== 2 ||
      originalFunction.split(ORIGINAL).length !== 2
    ) {
      throw new Error("Incomplete OpenClaw container restart patch");
    }
    return source;
  }
  if (originalFunction.split(ORIGINAL).length !== 2) {
    throw new Error("Unrecognized OpenClaw container restart boundary");
  }
  const patchedFunction = originalFunction.replace(ORIGINAL, () => REPLACEMENT);
  return source.replace(originalFunction, () => patchedFunction);
}

export function patchOpenClawContainerRestart(distDir: string, audit = false): void {
  const metadata = JSON.parse(fs.readFileSync(path.join(distDir, "..", "package.json"), "utf8"));
  // The Dockerfile restricts these pins to explicitly selected legacy E2E fixtures.
  if (["2026.3.11", "2026.4.24"].includes(metadata.version)) return;
  if (metadata.version !== VERSION) {
    throw new Error(`Unsupported OpenClaw version: ${metadata.version}`);
  }
  const target = path.join(distDir, "cli", "gateway-lifecycle.runtime.js");
  const source = fs.readFileSync(target, "utf8");
  const patched = patchContainerRestart(source);
  if (audit) {
    if (patched !== source) throw new Error("OpenClaw container restart patch is missing");
  } else if (patched !== source) {
    fs.writeFileSync(target, patched);
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
