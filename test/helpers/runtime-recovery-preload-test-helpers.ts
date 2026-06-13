// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { GATEWAY_PRELOAD_GUARDS } from "../../dist/lib/agent/runtime-recovery-preload";

const [SAFETY_NET_GUARD, CIAO_GUARD] = GATEWAY_PRELOAD_GUARDS;

export interface RecoveryPreloadHarnessPaths {
  preloadSourceSafetyNet: string;
  preloadSourceCiao: string;
  preloadTmpSafetyNet: string;
  preloadTmpCiao: string;
}

export function createRecoveryPreloadHarnessPaths(root: string): RecoveryPreloadHarnessPaths {
  const paths = {
    preloadSourceSafetyNet: path.join(root, "preload-source-safety-net.js"),
    preloadSourceCiao: path.join(root, "preload-source-ciao.js"),
    preloadTmpSafetyNet: path.join(root, "preload-tmp-safety-net.js"),
    preloadTmpCiao: path.join(root, "preload-tmp-ciao.js"),
  };
  fs.writeFileSync(paths.preloadSourceSafetyNet, "module.exports = 'trusted safety net';\n");
  fs.writeFileSync(paths.preloadSourceCiao, "module.exports = 'trusted ciao guard';\n");
  return paths;
}

export function rewriteRecoveryPreloadPaths(
  script: string,
  paths: RecoveryPreloadHarnessPaths,
): string {
  return script
    .replaceAll(SAFETY_NET_GUARD.tmpPath, paths.preloadTmpSafetyNet)
    .replaceAll(SAFETY_NET_GUARD.sourcePath, paths.preloadSourceSafetyNet)
    .replaceAll(CIAO_GUARD.tmpPath, paths.preloadTmpCiao)
    .replaceAll(CIAO_GUARD.sourcePath, paths.preloadSourceCiao);
}
