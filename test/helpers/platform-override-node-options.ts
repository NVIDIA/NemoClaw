// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

/**
 * `synthetic` makes every reachable listener count as the sandbox's own
 * ForwardTcp service. `real` keeps the production ownership proof, so a test
 * can stand up a genuine foreign listener and watch recovery refuse it.
 */
export type ForwardOwnerProof = "synthetic" | "real";

export function syntheticForwardNodeOptions(
  directory: string,
  inheritedNodeOptions = process.env.NODE_OPTIONS,
  ownerProof: ForwardOwnerProof = "synthetic",
): string {
  const preload = path.join(directory, "synthetic-forward-platform.cjs");
  const ownerOverride =
    ownerProof === "synthetic"
      ? [
          'const Module = require("node:module");',
          "const originalLoad = Module._load;",
          "Module._load = function loadSyntheticForward(request, parent, isMain) {",
          "  const loaded = originalLoad.call(this, request, parent, isMain);",
          '  if (String(request).endsWith("/adapters/openshell/forward-service")) {',
          "    loaded.isForwardServiceListenerOwner = () => true;",
          "  }",
          "  return loaded;",
          "};",
        ]
      : [];
  fs.writeFileSync(
    preload,
    [
      "delete process.env.WSL_DISTRO_NAME;",
      "delete process.env.WSL_INTEROP;",
      'require("node:os").release = () => "6.8.0-linux";',
      ...ownerOverride,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return [inheritedNodeOptions, `--require=${JSON.stringify(preload)}`].filter(Boolean).join(" ");
}
