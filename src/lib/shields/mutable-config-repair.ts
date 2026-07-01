// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const dockerExec: typeof import("../adapters/docker/exec") = require("../adapters/docker/exec");
const privilegedExecModule: typeof import("../sandbox/privileged-exec") = require("../sandbox/privileged-exec");

const MUTABLE_CONFIG_NORMALIZER = "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py";

function runPrivileged(sandboxName: string, cmd: string[], timeout = 15000): void {
  dockerExec.dockerExecFileSync(
    privilegedExecModule.privilegedSandboxExecArgv(sandboxName, cmd, false, true),
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    },
  );
}

function privilegedExecCapture(sandboxName: string, cmd: string[], timeout = 15000): string {
  return dockerExec
    .dockerExecFileSync(
      privilegedExecModule.privilegedSandboxExecArgv(sandboxName, cmd, false, true),
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
      },
    )
    .trim();
}

function sandboxIdentityId(sandboxName: string, flag: "-u" | "-g"): string {
  const id = privilegedExecCapture(sandboxName, ["/usr/bin/id", flag, "sandbox"]);
  if (!/^[1-9][0-9]*$/.test(id)) {
    const kind = flag === "-u" ? "UID" : "GID";
    throw new Error(`sandbox identity lookup returned an invalid ${kind}`);
  }
  return id;
}

/** Apply the mutable OpenClaw contract through the image's trusted helper. */
export function normalizeMutableOpenClawConfig(sandboxName: string, configDir: string): void {
  const sandboxUid = sandboxIdentityId(sandboxName, "-u");
  const sandboxGid = sandboxIdentityId(sandboxName, "-g");
  runPrivileged(sandboxName, [
    "/usr/bin/python3",
    "-I",
    MUTABLE_CONFIG_NORMALIZER,
    configDir,
    sandboxUid,
    sandboxGid,
  ]);
}
