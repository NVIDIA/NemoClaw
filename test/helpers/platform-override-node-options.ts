// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export function nonWslPlatformNodeOptions(
  directory: string,
  inheritedNodeOptions = process.env.NODE_OPTIONS,
): string {
  const preload = path.join(directory, "force-non-wsl-platform.cjs");
  fs.writeFileSync(
    preload,
    [
      "delete process.env.WSL_DISTRO_NAME;",
      "delete process.env.WSL_INTEROP;",
      'require("node:os").release = () => "6.8.0-linux";',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return [inheritedNodeOptions, `--require=${JSON.stringify(preload)}`].filter(Boolean).join(" ");
}
