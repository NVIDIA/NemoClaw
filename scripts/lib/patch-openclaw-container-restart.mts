#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// OpenClaw 2026.9.2 retains native ESM modules during in-process restarts.
// Keep native restart admission and shutdown, then refresh the process image
// inside the same OpenShell sandbox. Remove when upstream container restart
// reliably reloads changed plugin modules and their dependencies.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BROKER_SESSION_PROBE_SOURCE } from "./openclaw-broker-session-probe.mts";
import {
  OPENCLAW_COMMAND_SESSION_MODULES,
  OPENCLAW_COMMAND_TERMINATION_MODULES,
  patchCommandSessionCaller,
  patchCommandTerminationSessionCleanup,
  patchScopedCommandSessionCleanup,
} from "./openclaw-command-session-cleanup.mts";

const VERSIONS = ["2026.9.2", "2026.9.5", "2026.10.5"];
const BROKER_SESSION_MARKER =
  "// nemoclaw: observe owned broker session absence without group signals";
const BROKER_CLEANUP_SHA256 = "3103d7225a291eaab65003e96bba23a7700d62b00d37e8f30df998f4a64f5c6c";
const LOST_CHILD_CLEANUP_SHA256 =
  "6ed780d11dad0b8dd56f1207428f219f6b00bc387e8e32da6632e02f0d3e9a3f";
const LOST_CHILD_GROUP_PROBE = "isPidDefinitelyDead(pid) && (!detached || groupGone(pid))";
const LOST_CHILD_SESSION_PROBE =
  'isPidDefinitelyDead(pid) && (!detached || (process.platform === "linux" && process.env.OPENSHELL_SANDBOX === "1" ? nemoclawPrivateBrokerSessionGone(pid) : groupGone(pid)))';
const BROKER_CLEANUP_HEADER = "function terminateBrokerProcessGroup(pgid) {\n";
const BROKER_SESSION_DISPATCH = `\tconst brokerGroupGone = () => {
\t\tif (process.platform !== "linux" || process.env.OPENSHELL_SANDBOX !== "1") return groupGone(pgid);
\t\ttry { return nemoclawPrivateBrokerSessionGone(pgid); }
\t\tcatch (error) {
\t\t\t// A timer must retain an inventory failure for the native cleanup promise.
\t\t\tsignalError = error;
\t\t\treturn false;
\t\t}
\t};
`;
export const OPENCLAW_BROKER_CLEANUP_MODULES = [
  "state/openclaw-state-read.worker.js",
  "infra/sqlite-readonly-location.worker.js",
  "native-hook-relay/host-C-H3iw2x.mjs",
  "host-DtzWpmNE.mjs",
  "managed-handoff-runtime.mjs",
  "package-update-activation-recovery.mjs",
] as const;

/** Preserve native signals and deadlines; change only the private-session absence observation. */
export function patchBrokerPrivateSessionCleanup(source: string): string {
  const functions = [
    ...source.matchAll(/function terminateBrokerProcessGroup\(pgid\) \{[\s\S]*?\n\}/gu),
  ];
  if (functions.length !== 1) throw new Error("Expected one pinned broker cleanup function");
  const current = functions[0]![0];
  const helper = `${BROKER_SESSION_MARKER}\n${BROKER_SESSION_PROBE_SOURCE}\n`;
  const marked = source.includes(BROKER_SESSION_MARKER);
  const lostFunctions = [
    ...source.matchAll(
      /function terminateLostBrokerChild\(pid, detached, ownerExited\) \{[\s\S]*?\n\}/gu,
    ),
  ];
  if (lostFunctions.length !== 1)
    throw new Error("Expected one pinned lost-child cleanup function");
  const lostCurrent = lostFunctions[0]![0];
  const lostOriginal = marked
    ? lostCurrent.replace(LOST_CHILD_SESSION_PROBE, LOST_CHILD_GROUP_PROBE)
    : lostCurrent;
  if (createHash("sha256").update(lostOriginal).digest("hex") !== LOST_CHILD_CLEANUP_SHA256)
    throw new Error("Unrecognized pinned lost-child cleanup function");
  const lostPatched = lostOriginal.replace(LOST_CHILD_GROUP_PROBE, LOST_CHILD_SESSION_PROBE);
  const original = marked
    ? current
        .replace(BROKER_SESSION_DISPATCH, "")
        .replaceAll("brokerGroupGone()", "groupGone(pgid)")
    : current;
  if (createHash("sha256").update(original).digest("hex") !== BROKER_CLEANUP_SHA256)
    throw new Error("Unrecognized pinned broker cleanup function");
  const patched = original
    .replaceAll("groupGone(pgid)", "brokerGroupGone()")
    .replace(BROKER_CLEANUP_HEADER, BROKER_CLEANUP_HEADER + BROKER_SESSION_DISPATCH);
  if (marked) {
    if (
      source.split(helper).length !== 2 ||
      source.split(BROKER_SESSION_MARKER).length !== 2 ||
      source.split("function nemoclawPrivateBrokerSessionGone(").length !== 2 ||
      lostCurrent !== lostPatched ||
      current !== patched
    )
      throw new Error("Incomplete private broker session patch");
    return source;
  }
  if (source.includes("nemoclawPrivateBrokerSessionGone") || source.includes("brokerGroupGone"))
    throw new Error("Unexpected private broker session patch residue");
  return source.replace(current, () => helper + patched).replace(lostCurrent, () => lostPatched);
}

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

// Container recreation changes the PID namespace. A terminated owner's fresh
// heartbeat must remain authoritative until native admission classifies it as
// stale. Use the caller's existing admission budget; never reclaim the lock here.
export function patchGatewaySnapshotAdmission(source: string): string {
  const marker = "/* nemoclaw: wait for native namespace admission */";
  const replacements = [
    [
      "import { m as StateDatabaseAdmissionPendingError }",
      "import { b as GatewayLockNamespaceError, m as StateDatabaseAdmissionPendingError }",
    ],
    [
      "shouldRetry: (error) => error instanceof StateDatabaseAdmissionPendingError && error.databasePath === pathname,",
      `${marker}\n\t\t\t\tshouldRetry: (error) => error instanceof StateDatabaseAdmissionPendingError && error.databasePath === pathname || process.env.OPENSHELL_SANDBOX === "1" && error instanceof GatewayLockNamespaceError,`,
    ],
  ] as const;
  const patched = source.includes(marker);
  if (source.split("async function withOpenClawStateDatabaseReadSnapshot(").length !== 2)
    throw new Error("Expected one native state snapshot admission function");
  if (
    replacements.some(([before, after]) => source.split(patched ? after : before).length !== 2) ||
    (patched &&
      (source.split(marker).length !== 2 ||
        replacements.some(([before]) => source.includes(before))))
  )
    throw new Error("Unrecognized or incomplete OpenClaw state snapshot admission patch");
  return patched
    ? source
    : replacements.reduce<string>(
        (text, [before, after]) => text.replace(before, () => after),
        source,
      );
}

export function patchOpenClawContainerRestart(distDir: string, audit = false): void {
  const metadata = JSON.parse(fs.readFileSync(path.join(distDir, "..", "package.json"), "utf8"));
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
  const snapshotFiles =
    metadata.version === "2026.10.5"
      ? fs
          .readdirSync(distDir)
          .filter(
            (name) =>
              /^openclaw-state-db-readonly-.*\.mjs$/u.test(name) &&
              fs
                .readFileSync(path.join(distDir, name), "utf8")
                .includes("async function withOpenClawStateDatabaseReadSnapshot("),
          )
      : [];
  if (metadata.version === "2026.10.5" && snapshotFiles.length !== 1)
    throw new Error("Expected one native state snapshot admission module");
  const waitModule =
    metadata.version === "2026.10.5"
      ? fs.readFileSync(path.join(distDir, "exec-spawn-DQCCtyab.mjs"), "utf8")
      : "";
  const cleanupModules = [
    ...new Set<string>([
      ...OPENCLAW_BROKER_CLEANUP_MODULES,
      ...OPENCLAW_COMMAND_SESSION_MODULES,
      ...OPENCLAW_COMMAND_TERMINATION_MODULES,
      "settings-manager-CKysicKB.mjs",
    ]),
  ];
  const patches = [
    ...(metadata.version === "2026.10.5"
      ? cleanupModules.map((name) => ({
          target: path.join(distDir, name),
          patch: (source: string) => {
            let patched = source;
            if (OPENCLAW_BROKER_CLEANUP_MODULES.some((module) => module === name))
              patched = patchBrokerPrivateSessionCleanup(patched);
            if (OPENCLAW_COMMAND_SESSION_MODULES.some((module) => module === name))
              patched = patchScopedCommandSessionCleanup(patched);
            if (OPENCLAW_COMMAND_TERMINATION_MODULES.some((module) => module === name))
              patched = patchCommandTerminationSessionCleanup(patched, waitModule);
            if (name === "settings-manager-CKysicKB.mjs")
              patched = patchCommandSessionCaller(patched, true);
            return patched;
          },
        }))
      : []),
    {
      target: path.join(distDir, "cli", "gateway-lifecycle.runtime.js"),
      patch: (source: string) => patchContainerRestart(source, metadata.version),
    },
    { target: safeRestartFiles[0]!, patch: patchHostSafeRestart },
    ...snapshotFiles.map((name) => ({
      target: path.join(distDir, name),
      patch: patchGatewaySnapshotAdmission,
    })),
    ...(metadata.version !== "2026.9.2"
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
