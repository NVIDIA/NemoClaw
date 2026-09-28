// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV = "NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE";

export function gatewayIdForStateDir(stateDir: string): string {
  const leaf = path.basename(path.resolve(stateDir)).replace(/[^A-Za-z0-9_.-]/g, "-");
  const scope = `${String(process.getuid?.() ?? "unknown")}\0${path.resolve(stateDir)}`;
  const suffix = createHash("sha256").update(scope).digest("hex").slice(0, 12);
  return `nemoclaw-${leaf || "gateway"}-${suffix}`;
}

export function processEnvironmentUsesSelectedGatewayState(
  processEnv: Readonly<Record<string, string>>,
  stateDir: string,
): boolean {
  const selectedNamespace = gatewayIdForStateDir(stateDir);
  const namespace = processEnv[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV];
  const databaseUrl = processEnv.OPENSHELL_DB_URL;
  const selectedDatabaseUrl = `sqlite:${path.join(stateDir, "openshell.db")}`;
  if (databaseUrl !== undefined && databaseUrl !== selectedDatabaseUrl) return false;
  if (namespace === selectedNamespace) return true;
  return (
    (namespace === undefined || namespace === "default") && databaseUrl === selectedDatabaseUrl
  );
}

export function readGatewayProcessEnvironment(pid: number): Record<string, string> | null {
  const procEnvPath = `/proc/${pid}/environ`;
  const env: Record<string, string> = {};
  try {
    if (!fs.existsSync(procEnvPath)) return null;
    for (const entry of fs.readFileSync(procEnvPath, "utf-8").split("\0")) {
      if (!entry) continue;
      const separator = entry.indexOf("=");
      if (separator <= 0) continue;
      env[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  } catch {
    return null;
  }
  return env;
}
