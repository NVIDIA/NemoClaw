// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

/** Model an already healthy receipt-owned ForwardTcp service in CLI subprocess fixtures. */
export function healthyForwardServiceNodeOptions(
  directory: string,
  inheritedNodeOptions = process.env.NODE_OPTIONS,
): string {
  const preload = path.join(directory, "healthy-forward-service-controller.cjs");
  fs.writeFileSync(
    preload,
    [
      'const Module = require("node:module");',
      'const original = Module._extensions[".js"];',
      'Module._extensions[".js"] = (loaded, filename) => {',
      "  original(loaded, filename);",
      '  if (!filename.endsWith("/lib/adapters/openshell/forward-service-controller.js")) return;',
      "  loaded.exports.createForwardServiceController = () => ({",
      '    inspect: () => ({ disposition: "owned", ownsListener: true, reachable: true, receipt: {} }),',
      '    ensure: () => ({ action: "reused", receipt: {} }),',
      '    stop: () => "absent",',
      '    stopPort: () => "absent",',
      "    stopAll: () => 0,",
      "  });",
      "};",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return [inheritedNodeOptions, `--require=${JSON.stringify(preload)}`].filter(Boolean).join(" ");
}
