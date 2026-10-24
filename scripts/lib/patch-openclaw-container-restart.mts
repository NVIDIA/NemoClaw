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

const VERSIONS = ["2026.9.1", "2026.9.5", "2026.10.5"];
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

const DECISION_BOUNDARY = `\tconst decision = opts.decision ?? resolveGatewayRestartDecision();
\tif (decision.mode === "disabled") return decision.reason === "no-respawn" ? { mode: "disabled" } : {
\t\tmode: "disabled",
\t\tdetail: decision.detail
\t};`;
const DECISION_REPLACEMENT = DECISION_BOUNDARY.replace(
  '\n\tif (decision.mode === "disabled")',
  `
\t${MARKER}
\tif (decision.mode === "disabled" && decision.reason === "unmanaged" && process.platform === "linux" && process.env.OPENSHELL_SANDBOX === "1") {
\t\tif (typeof process.execve !== "function") throw new Error("OpenClaw sandbox restart requires process.execve");
\t\t// OpenShell Node bootstrap arguments are single-use; replay only application argv.
\t\tprocess.execve(process.execPath, process.argv, { ...process.env, ...opts.env });
\t\tthrow new Error("OpenClaw sandbox process replacement unexpectedly returned");
\t}
\tif (decision.mode === "disabled")`,
);

export function patchContainerRestart(source: string, version = "2026.9.5"): string {
  if (!VERSIONS.includes(version)) throw new Error(`Unsupported OpenClaw version: ${version}`);
  const current = version === "2026.10.5";
  const boundary = current ? DECISION_BOUNDARY : ORIGINAL;
  const replacement = current ? DECISION_REPLACEMENT : REPLACEMENT;
  const matches = [
    ...source.matchAll(
      current
        ? /function restartGatewayProcessWithFreshPid\(opts = \{\}\) \{[\s\S]*?\n\}/gu
        : /function restartGatewayProcessWithFreshPid\(_opts = \{\}\) \{[\s\S]*?\n\}/gu,
    ),
  ];
  if (matches.length !== 1) throw new Error("Expected one native gateway restart function");
  const originalFunction = matches[0]![0];
  if (source.includes(MARKER)) {
    if (
      source.split(MARKER).length !== 2 ||
      originalFunction.split(replacement).length !== 2 ||
      originalFunction.replace(replacement, "").includes(boundary)
    ) {
      throw new Error("Incomplete OpenClaw container restart patch");
    }
    return source;
  }
  if (originalFunction.split(boundary).length !== 2) {
    throw new Error("Unrecognized OpenClaw container restart boundary");
  }
  const patchedFunction = originalFunction.replace(boundary, () => replacement);
  return source.replace(originalFunction, () => patchedFunction);
}

const HOST_RESTART_MARKER = "// nemoclaw: authenticate host safe restart as the local backend";
const HOST_RESTART_TARGET =
  '\tconst result = await callGatewayCli({\n\t\tmethod: "gateway.restart.request",\n\t\tparams,';
const HOST_RESTART_REPLACEMENT = `${HOST_RESTART_TARGET}
\t\t${HOST_RESTART_MARKER}
\t\t...process.env.OPENSHELL_SANDBOX === "1" && process.env.NEMOCLAW_OPENCLAW_HOST_RESTART === "1" ? {
\t\t\tclientName: "gateway-client",
\t\t\tmode: "backend",
\t\t\trequireLocalBackendSharedAuth: true,
\t\t\tsharedStateMode: "read-only"
\t\t} : {},`;

export function patchHostSafeRestart(source: string): string {
  const matches = [
    ...source.matchAll(
      /async function runSafeGatewayRestart\(opts(?:, target)?\) \{[\s\S]*?\n\}/gu,
    ),
  ];
  if (matches.length !== 1) throw new Error("Expected one native safe restart function");
  const original = matches[0]![0];
  if (source.includes(HOST_RESTART_MARKER)) {
    if (
      source.split(HOST_RESTART_MARKER).length !== 2 ||
      original.split(HOST_RESTART_REPLACEMENT).length !== 2
    )
      throw new Error("Incomplete OpenClaw host safe restart patch");
    return source;
  }
  if (original.split(HOST_RESTART_TARGET).length !== 2)
    throw new Error("Unrecognized OpenClaw safe restart boundary");
  return source.replace(original, () =>
    original.replace(HOST_RESTART_TARGET, HOST_RESTART_REPLACEMENT),
  );
}

const PROXY_SHUTDOWN_MARKER = "// nemoclaw: let the gateway finish shutdown before proxy exit";
const PROXY_SHUTDOWN_TARGET =
  "\t\tunregisterProxySignalExitBarrier = registerSignalExitBarrier(stopStartedProxy);\n\t\tconst shutdown = (exitCode) => {";
const PROXY_SHUTDOWN_REPLACEMENT = `\t\tunregisterProxySignalExitBarrier = registerSignalExitBarrier(stopStartedProxy);
\t\t${PROXY_SHUTDOWN_MARKER}
\t\tif (isGatewayRunInvocation) {
\t\t\tonExit = () => killStartedProxy();
\t\t\tprocess$1.once("exit", onExit);
\t\t\treturn;
\t\t}
\t\tconst shutdown = (exitCode) => {`;

// In 2026.9.5 the CLI proxy's signal handler exits while the gateway is still
// closing its server, leaving its owner lease in a reused managed state volume.
// Keep proxy cleanup registered, with process exit owned by the gateway lifecycle.
export function patchGatewayProxyShutdown(source: string, version = "2026.9.5"): string {
  if (!["2026.9.5", "2026.10.5"].includes(version))
    throw new Error(`Unsupported OpenClaw proxy shutdown version: ${version}`);
  const current = version === "2026.10.5";
  const guard = current
    ? "\t\tif (!proxyHandle || proxySignalHandlers.length > 0) return;\n"
    : "\t\tif (!proxyHandle || onSigterm || onSigint || onExit) return;\n";
  const target = guard + PROXY_SHUTDOWN_TARGET;
  const replacement =
    guard +
    (current
      ? PROXY_SHUTDOWN_REPLACEMENT.replace(
          '\t\t\tonExit = () => killStartedProxy();\n\t\t\tprocess$1.once("exit", onExit);',
          '\t\t\tproxySignalHandlers = [["exit", killStartedProxy]];\n\t\t\tfor (const [signal, handler] of proxySignalHandlers) process$1.once(signal, handler);',
        )
      : PROXY_SHUTDOWN_REPLACEMENT);
  const matches = [
    ...source.matchAll(/\tconst installProxySignalHandlers = \(\) => \{[\s\S]*?\n\t\};/gu),
  ];
  if (matches.length !== 1) throw new Error("Expected one native proxy signal installer");
  const original = matches[0]![0];
  if (source.includes(PROXY_SHUTDOWN_MARKER)) {
    if (
      source.split(PROXY_SHUTDOWN_MARKER).length !== 2 ||
      original.split(replacement).length !== 2 ||
      original.replace(replacement, "").includes(target)
    ) {
      throw new Error("Incomplete OpenClaw gateway proxy shutdown patch");
    }
    return source;
  }
  if (original.split(target).length !== 2) {
    throw new Error("Unrecognized OpenClaw proxy shutdown boundary");
  }
  return source.replace(original, () => original.replace(target, () => replacement));
}

export function patchOpenClawContainerRestart(distDir: string, audit = false): void {
  const metadata = JSON.parse(fs.readFileSync(path.join(distDir, "..", "package.json"), "utf8"));
  // The Dockerfile restricts these pins to explicitly selected legacy E2E fixtures.
  if (["2026.3.11", "2026.4.24"].includes(metadata.version)) return;
  if (!VERSIONS.includes(metadata.version)) {
    throw new Error(`Unsupported OpenClaw version: ${metadata.version}`);
  }
  const safeRestartFiles = fs
    .readdirSync(distDir)
    .filter((name) => name.startsWith("lifecycle-") && /\.m?js$/u.test(name))
    .map((name) => path.join(distDir, name))
    .filter((file) =>
      fs.readFileSync(file, "utf8").includes("async function runSafeGatewayRestart("),
    );
  if (safeRestartFiles.length !== 1) throw new Error("Expected one native safe restart module");
  const patches = [
    {
      target: path.join(distDir, "cli", "gateway-lifecycle.runtime.js"),
      patch: (source: string) => patchContainerRestart(source, metadata.version),
    },
    { target: safeRestartFiles[0]!, patch: patchHostSafeRestart },
    ...(metadata.version !== "2026.9.1"
      ? [
          {
            target: path.join(distDir, "cli", "run-main.js"),
            patch: (source: string) => patchGatewayProxyShutdown(source, metadata.version),
          },
        ]
      : []),
  ].map(({ target, patch }) => {
    const source = fs.readFileSync(target, "utf8");
    return { target, source, patched: patch(source) };
  });
  for (const { target, source, patched } of patches) {
    if (audit) {
      if (patched !== source) throw new Error("OpenClaw container restart patch is missing");
    } else if (patched !== source) fs.writeFileSync(target, patched);
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
