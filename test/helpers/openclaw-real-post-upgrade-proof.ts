// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Exercise the shipped restore checks against state created by native OpenClaw. */
export function proveRealPostUpgradeChecks(
  stateDir: string,
  dist: string,
  nodeExecutable: string,
): void {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../scripts/nemoclaw-start.sh"),
    "utf8",
  );
  for (const tag of ["NODEREPAIR", "NODELEASE"]) {
    const programs = [...source.matchAll(new RegExp(`<<'${tag}'[^\\n]*\\n(.*?)\\n${tag}`, "gs"))];
    if (programs.length !== 1) throw new Error(`Expected one shipped ${tag} check`);
    const program = programs[0]![1]!.replaceAll(
      "/sandbox/.openclaw/state/openclaw.sqlite",
      path.join(stateDir, "state", "openclaw.sqlite"),
    );
    const result = spawnSync(nodeExecutable, ["-", path.join(path.dirname(dist), "openclaw.mjs")], {
      input: program,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        HOME: stateDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        OPENCLAW_NO_RESPAWN: "1",
      },
    });
    if (result.status !== 0) {
      throw new Error(`Native post-upgrade ${tag} failed: ${result.error ?? result.stderr}`);
    }
  }
}
