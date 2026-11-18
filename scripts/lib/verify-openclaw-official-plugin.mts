#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type ProvenanceCondition =
  | "inspection failed"
  | "inspection timed out"
  | "inspection did not return JSON"
  | "did not retain trusted exact registry provenance";

export class OfficialPluginProvenanceError extends Error {
  readonly pluginId: string;
  readonly condition: ProvenanceCondition;
  readonly inspectionDiagnostics?: string;

  constructor(pluginId: string, condition: ProvenanceCondition, inspectionDiagnostics?: string) {
    super(`OpenClaw official npm plugin ${pluginId} ${condition}`);
    this.pluginId = pluginId;
    this.condition = condition;
    this.inspectionDiagnostics = inspectionDiagnostics;
  }
}

/** Never forward plugin output: only fixed phase names, numbers and booleans leave this boundary. */
function inspectionDiagnostics(
  identity: OfficialPluginIdentity,
  stdout: string,
  stderr: string,
  elapsedMs: number,
): string {
  const phases = new Set([
    "config read",
    "discovery scan",
    "plugin metadata load",
    "plugin registry snapshot",
  ]);
  let lastCompletedPhase: string | undefined;
  let phaseStatus: string | undefined;
  let phaseMs: number | undefined;
  for (const line of stderr.split("\n")) {
    const match =
      /^\[plugins:lifecycle\] phase="([a-z ]+)" ms=([0-9]+(?:\.[0-9]+)?) status=(ok|error)(?: .*)?$/.exec(
        line,
      );
    if (!match || !phases.has(match[1]!)) continue;
    const duration = Number(match[2]);
    if (!Number.isFinite(duration) || duration > 90_000) continue;
    lastCompletedPhase = match[1];
    phaseStatus = match[3];
    phaseMs = duration;
  }
  let stdoutJson = false;
  let provenanceValid = false;
  try {
    JSON.parse(stdout);
    stdoutJson = true;
    verifyOfficialOpenClawPluginInstall(identity, stdout);
    provenanceValid = true;
  } catch {
    // Diagnostic evidence never changes the command's failure classification.
  }
  return JSON.stringify({
    elapsedMs,
    lastCompletedPhase,
    phaseStatus,
    phaseMs,
    stdoutJson,
    provenanceValid,
  });
}

type OfficialPluginIdentity = Readonly<{
  pluginId: string;
  packageSpec: string;
  integrity: string;
}>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Local npm-pack installs are not official installs, even with matching bytes. */
export function verifyOfficialOpenClawPluginInstall(
  identity: OfficialPluginIdentity,
  inspectOutput: string,
): string | undefined {
  let inspected: unknown;
  try {
    inspected = JSON.parse(inspectOutput);
  } catch {
    throw new OfficialPluginProvenanceError(identity.pluginId, "inspection did not return JSON");
  }
  const root = record(inspected);
  const install = record(root.install);
  const plugin = record(root.plugin);
  if (
    plugin.id !== identity.pluginId ||
    plugin.trustedOfficialInstall !== true ||
    install.source !== "npm" ||
    install.sourcePath !== undefined ||
    install.artifactKind !== undefined ||
    install.resolvedSpec !== identity.packageSpec ||
    install.integrity !== identity.integrity
  ) {
    throw new OfficialPluginProvenanceError(
      identity.pluginId,
      "did not retain trusted exact registry provenance",
    );
  }
  return typeof install.installPath === "string"
    ? install.installPath.trim() || undefined
    : undefined;
}

/** Bound native inspection and suppress child output that may contain config secrets. */
export function inspectOfficialOpenClawPluginInstall(
  identity: OfficialPluginIdentity,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const ownsProcessGroup = process.platform !== "win32";
  const started = performance.now();
  const result = spawnSync("openclaw", ["plugins", "inspect", identity.pluginId, "--json"], {
    encoding: "utf8",
    env: { ...env, OPENCLAW_PLUGIN_LIFECYCLE_TRACE: "1" },
    timeout: 90_000,
    killSignal: "SIGKILL",
    ...(ownsProcessGroup ? { detached: true } : {}),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (timedOut && ownsProcessGroup && result.pid > 0) {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw new OfficialPluginProvenanceError(identity.pluginId, "inspection failed");
      }
    }
  }
  if (result.error || result.status !== 0) {
    throw new OfficialPluginProvenanceError(
      identity.pluginId,
      timedOut ? "inspection timed out" : "inspection failed",
      inspectionDiagnostics(
        identity,
        result.stdout ?? "",
        result.stderr ?? "",
        Math.round(performance.now() - started),
      ),
    );
  }
  return verifyOfficialOpenClawPluginInstall(identity, result.stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [pluginId, packageSpec, integrity, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !pluginId ||
    !/^[a-z][a-z0-9-]*$/.test(pluginId) ||
    !packageSpec ||
    !/^@openclaw\/[a-z][a-z0-9-]*@[0-9]+\.[0-9]+\.[0-9]+$/.test(packageSpec) ||
    !integrity ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
  ) {
    console.error("Expected official plugin ID, exact npm package spec, and SHA512 integrity");
    process.exitCode = 1;
  } else {
    try {
      inspectOfficialOpenClawPluginInstall({ pluginId, packageSpec, integrity }, process.env);
    } catch (error) {
      console.error(
        error instanceof OfficialPluginProvenanceError
          ? `${error.message}${error.inspectionDiagnostics ? ` Inspection diagnostics: ${error.inspectionDiagnostics}.` : ""}`
          : "Official plugin inspection failed",
      );
      process.exitCode = 1;
    }
  }
}
