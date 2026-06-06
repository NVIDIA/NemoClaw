// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";

import { defaultUninstallPaths } from "../../domain/uninstall/paths";
import {
  buildUninstallPlan,
  type UninstallPlan,
  type UninstallPlanOptions,
} from "../../domain/uninstall/plan";
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

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as { code?: string }).code : undefined;
}

function classifyShimPathByMetadata(
  shimPath: string,
  lstatSync: typeof fs.lstatSync,
): ShimClassification {
  try {
    const stat = lstatSync(shimPath);
    return classifyNemoclawShim({
      exists: true,
      isFile: stat.isFile(),
      isSymlink: stat.isSymbolicLink(),
    });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return classifyNemoclawShim({ exists: false, isFile: false, isSymlink: false });
    }
    throw error;
  }
}

function resolveUninstallHome(envHome: string | undefined): string {
  return envHome || os.homedir();
}

export function classifyShimPath(shimPath: string, deps: FileSystemDeps = {}): ShimClassification {
  const lstatSync = deps.lstatSync ?? fs.lstatSync;
  const openSync = deps.openSync ?? fs.openSync;
  const fstatSync = deps.fstatSync ?? fs.fstatSync;
  const readFileSync = deps.readFileSync ?? fs.readFileSync;
  const closeSync = deps.closeSync ?? fs.closeSync;
  const noFollowFlag =
    typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : undefined;
  if (noFollowFlag === undefined) {
    return classifyShimPathByMetadata(shimPath, lstatSync);
  }
  const nonblockFlag = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  try {
    const fd = openSync(shimPath, fs.constants.O_RDONLY | noFollowFlag | nonblockFlag);
    try {
      const fdStat = fstatSync(fd);
      return classifyNemoclawShim({
        contents: fdStat.isFile() ? String(readFileSync(fd, "utf-8")) : undefined,
        exists: true,
        isFile: fdStat.isFile(),
        isSymlink: false,
      });
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") {
      return classifyNemoclawShim({ exists: false, isFile: false, isSymlink: false });
    }
    if (
      code === "ELOOP" ||
      code === "EISDIR" ||
      code === "EACCES" ||
      code === "EPERM" ||
      code === "ENXIO" ||
      code === "ENODEV" ||
      code === "ENOTSUP"
    ) {
      return classifyShimPathByMetadata(shimPath, lstatSync);
    }
    throw error;
  }
}

export function buildHostUninstallPlan(options: HostUninstallPlanOptions): UninstallPlan {
  const home = resolveUninstallHome(options.env.HOME);
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
