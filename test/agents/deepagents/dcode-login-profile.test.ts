// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

// The live fresh-reonboard check owns Linux /etc/profile.d ordering against
// personal profiles. This test executes the hook's environment changes only.
function runHook(command: string) {
  return spawnSync(
    "/bin/bash",
    [
      "--noprofile",
      "--norc",
      "-p",
      "-c",
      '. agents/langchain-deepagents-code/dcode-login-profile.sh; printf \'%s\\n\' "$HOME" "${BASH_ENV-unset}" "${ENV-unset}"; ' +
        command,
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        HOME: "/sandbox",
        BASH_ENV: "/sandbox/.bashrc",
        ENV: "/sandbox/.profile",
      },
    },
  );
}

describe("managed DCode system login hook", () => {
  it("selects the image-owned home and clears startup hooks for managed exec (#11256)", () => {
    const result = runHook(": /usr/local/lib/nemoclaw/dcode-managed-exec");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("/usr/local/lib/nemoclaw\nunset\nunset\n");
    expect(result.stderr).toBe("");
  });

  it("leaves the agent's home and startup hooks unchanged for ordinary commands (#11256)", () => {
    const result = runHook(":");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("/sandbox\n/sandbox/.bashrc\n/sandbox/.profile\n");
    expect(result.stderr).toBe("");
  });
});
