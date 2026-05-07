// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- covered by source-level unit tests; CLI coverage tracks dist integration. */
import fs from "node:fs";

import { defaultUninstallPaths } from "../../domain/uninstall/paths";
import { buildUninstallPlan, type UninstallPlan, type UninstallPlanOptions } from "../../domain/uninstall/plan";
import { classifyNemoclawShim, type ShimClassification } from "../../domain/uninstall/shims";

export interface FileSystemDeps {
  lstatSync?: typeof fs.lstatSync;
  readFileSync?: typeof fs.readFileSync;
}

export interface HostUninstallPlanOptions extends Omit<UninstallPlanOptions, "shim"> {
  env: Partial<Pick<NodeJS.ProcessEnv, "HOME" | "TMPDIR" | "XDG_BIN_HOME">>;
  fs?: FileSystemDeps;
}

export function classifyShimPath(shimPath: string, deps: FileSystemDeps = {}): ShimClassification {
  const lstatSync = deps.lstatSync ?? fs.lstatSync;
  const readFileSync = deps.readFileSync ?? fs.readFileSync;
  try {
    const stat = lstatSync(shimPath);
    const isFile = stat.isFile();
    return classifyNemoclawShim({
      contents: isFile ? String(readFileSync(shimPath, "utf-8")) : undefined,
      exists: true,
      isFile,
      isSymlink: stat.isSymbolicLink(),
    });
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;
    if (code === "ENOENT") {
      return classifyNemoclawShim({ exists: false, isFile: false, isSymlink: false });
    }
    throw error;
  }
}

export function buildHostUninstallPlan(options: HostUninstallPlanOptions): UninstallPlan {
  const home = options.env.HOME || "/tmp";
  const paths = defaultUninstallPaths({
    home,
    tmpDir: options.env.TMPDIR,
    xdgBinHome: options.env.XDG_BIN_HOME,
  });
  return buildUninstallPlan(paths, {
    deleteModels: options.deleteModels,
    gatewayName: options.gatewayName,
    keepOpenShell: options.keepOpenShell,
    shim: classifyShimPath(paths.nemoclawShimPath, options.fs),
  });
}
/* v8 ignore stop */
