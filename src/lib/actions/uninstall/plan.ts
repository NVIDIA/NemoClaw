// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { defaultUninstallPaths } from "../../domain/uninstall/paths";
import { buildUninstallPlan, type UninstallPlan, type UninstallPlanOptions } from "../../domain/uninstall/plan";
import { classifyNemoclawShim, type ShimClassification } from "../../domain/uninstall/shims";

export interface FileSystemDeps {
  closeSync?: typeof fs.closeSync;
  fstatSync?: typeof fs.fstatSync;
  lstatSync?: typeof fs.lstatSync;
  openSync?: typeof fs.openSync;
  readFileSync?: typeof fs.readFileSync;
}

export interface HostUninstallPlanOptions extends Omit<UninstallPlanOptions, "shim"> {
  env: Partial<Pick<NodeJS.ProcessEnv, "HOME" | "TMPDIR" | "XDG_BIN_HOME">>;
  fs?: FileSystemDeps;
}

export function classifyShimPath(shimPath: string, deps: FileSystemDeps = {}): ShimClassification {
  const lstatSync = deps.lstatSync ?? fs.lstatSync;
  const openSync = deps.openSync ?? fs.openSync;
  const fstatSync = deps.fstatSync ?? fs.fstatSync;
  const readFileSync = deps.readFileSync ?? fs.readFileSync;
  const closeSync = deps.closeSync ?? fs.closeSync;
  try {
    const stat = lstatSync(shimPath);
    const isFile = stat.isFile();
    let contents: string | undefined;
    if (isFile) {
      const fd = openSync(shimPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const fdStat = fstatSync(fd);
        if (fdStat.isFile()) {
          contents = String(readFileSync(fd, "utf-8"));
        }
      } finally {
        closeSync(fd);
      }
    }
    return classifyNemoclawShim({
      contents,
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
