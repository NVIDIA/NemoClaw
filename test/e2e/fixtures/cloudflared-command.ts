// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

/** A local command fixture for package, extraction, and executable checks. */
export function cloudflaredCommandFixture(failure: string, bytes: Buffer) {
  let packagePath = "";
  const command = async (name: string, args: string[]) => {
    let exitCode = 0;
    let stdout = "";
    if (name === "curl") {
      packagePath = args[args.indexOf("--output") + 1];
      fs.writeFileSync(packagePath, failure === "digest" ? "substituted" : bytes);
    } else if (name === "dpkg-deb") {
      if (failure === "extract") exitCode = 1;
      else {
        const binary = path.join(args[2], "usr", "bin", "cloudflared");
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, "fixture binary", { mode: 0o700 });
      }
    } else {
      exitCode = failure === "execute" ? 126 : 0;
      stdout = `cloudflared version ${failure === "version" ? "2025.1.1" : "2026.6.1"}`;
    }
    return {
      command: [name, ...args],
      exitCode,
      stdout,
      stderr: "",
      signal: null,
      timedOut: false,
      artifacts: { stdout: "", stderr: "", result: "" },
    };
  };
  return { command, packagePath: () => packagePath };
}
