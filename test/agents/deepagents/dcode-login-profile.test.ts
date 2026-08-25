// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const sourcePath = path.join(
  repoRoot,
  "agents",
  "langchain-deepagents-code",
  "dcode-login-profile.sh",
);
const tempDirs: string[] = [];

function fixture(): {
  fallbackMarker: string;
  hookMarker: string;
  home: string;
  runtimeEnv: string;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-login-profile-"));
  tempDirs.push(home);
  const runtimeEnv = path.join(home, "runtime-env.sh");
  const hook = path.join(home, "hostile-bash-env.sh");
  const hookMarker = path.join(home, "hook-ran");
  const fallbackMarker = path.join(home, "fallback-ran");
  const source = fs
    .readFileSync(sourcePath, "utf8")
    .replaceAll("/tmp/nemoclaw-proxy-env.sh", runtimeEnv);

  fs.writeFileSync(path.join(home, ".bash_profile"), source, "utf8");
  fs.writeFileSync(path.join(home, ".bash_login"), `printf ran > ${fallbackMarker}\n`, "utf8");
  fs.writeFileSync(hook, `printf ran > ${hookMarker}\n`, "utf8");
  return { fallbackMarker, hookMarker, home, runtimeEnv };
}

describe("managed DCode login profile", () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("skips sandbox startup hooks before a managed exec command (#8624)", () => {
    const { fallbackMarker, hookMarker, home, runtimeEnv } = fixture();
    const runtimeMarker = path.join(home, "runtime-env-ran");
    fs.writeFileSync(runtimeEnv, `printf ran > ${runtimeMarker}\n`, "utf8");

    const result = spawnSync(
      "/bin/bash",
      ["-lc", ": /usr/local/lib/nemoclaw/dcode-managed-exec; printf '%s\\n' MANAGED_COMMAND_RAN"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BASH_ENV: path.join(home, "hostile-bash-env.sh"),
          ENV: path.join(home, "hostile-bash-env.sh"),
          HOME: home,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("MANAGED_COMMAND_RAN\n");
    expect(result.stderr).toBe("");
    expect(fs.existsSync(runtimeMarker)).toBe(false);
    expect(fs.existsSync(hookMarker)).toBe(false);
    expect(fs.existsSync(fallbackMarker)).toBe(false);
  });

  it("preserves the managed runtime environment for ordinary login commands (#6191)", () => {
    const { fallbackMarker, hookMarker, home, runtimeEnv } = fixture();
    fs.writeFileSync(runtimeEnv, "export NEMOCLAW_DCODE_LOGIN_TEST=preserved\n", "utf8");

    const result = spawnSync(
      "/bin/bash",
      ["-lc", "printf '%s\\n' \"$NEMOCLAW_DCODE_LOGIN_TEST\""],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BASH_ENV: path.join(home, "hostile-bash-env.sh"),
          ENV: path.join(home, "hostile-bash-env.sh"),
          HOME: home,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("preserved\n");
    expect(result.stderr).toBe("");
    expect(fs.existsSync(hookMarker)).toBe(false);
    expect(fs.existsSync(fallbackMarker)).toBe(false);
  });
});
