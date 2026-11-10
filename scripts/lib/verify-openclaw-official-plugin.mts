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

  constructor(pluginId: string, condition: ProvenanceCondition) {
    super(`OpenClaw official npm plugin ${pluginId} ${condition}`);
    this.pluginId = pluginId;
    this.condition = condition;
  }
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
  const result = spawnSync("openclaw", ["plugins", "inspect", identity.pluginId, "--json"], {
    encoding: "utf8",
    env,
    timeout: 60_000,
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
          ? error.message
          : "Official plugin inspection failed",
      );
      process.exitCode = 1;
    }
  }
}
