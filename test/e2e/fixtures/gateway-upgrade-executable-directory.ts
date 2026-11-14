// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HostCliClient } from "./clients/host.ts";
import { resultText } from "./clients/command.ts";

// Historical installers accept writable system directories. Prepare the disposable
// runner before those installers run; the current installer still owns its checks.
export const GATEWAY_UPGRADE_EXECUTABLE_DIRECTORY_SCRIPT = `
import contextlib, json, os, stat, sys

target, uid_text = sys.argv[1:]
if not uid_text.isdecimal():
    raise ValueError("invalid runner uid")
uid = int(uid_text)
parts = target.split("/")[1:]
if not target.startswith("/") or not parts or any(p in ("", ".", "..") for p in parts):
    raise ValueError("executable directory must be canonical and absolute")
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
with contextlib.ExitStack() as stack:
    fd = os.open("/", flags)
    stack.callback(os.close, fd)
    for index, part in enumerate([None] + parts):
        if part is not None:
            fd = os.open(part, flags, dir_fd=fd)
            stack.callback(os.close, fd)
        metadata = os.fstat(fd)
        mode = stat.S_IMODE(metadata.st_mode)
        if metadata.st_uid not in (0, uid):
            raise ValueError("foreign executable directory owner")
        if index < len(parts) and mode & 0o022:
            if metadata.st_uid != 0 or not mode & stat.S_ISVTX:
                raise ValueError("unsafe executable directory ancestor")
    expected_mode = mode & ~0o022
    os.fchmod(fd, expected_mode)
    after = os.stat(target, follow_symlinks=False)
    if (after.st_dev, after.st_ino, after.st_uid, stat.S_IMODE(after.st_mode)) != (
        metadata.st_dev, metadata.st_ino, metadata.st_uid, expected_mode
    ):
        raise ValueError("executable directory changed during preparation")
    print(json.dumps({"path": target, "uid": after.st_uid,
                      "beforeMode": oct(mode), "afterMode": oct(expected_mode)}))
`;

export async function prepareGatewayUpgradeExecutableDirectory(
  host: Pick<HostCliClient, "command">,
  env: NodeJS.ProcessEnv,
  enabled = process.platform === "linux" &&
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted",
): Promise<void> {
  if (!enabled) return;
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) {
    throw new Error("Cannot identify the disposable runner user");
  }
  const result = await host.command(
    "/usr/bin/sudo",
    [
      "-n",
      "/usr/bin/python3",
      "-I",
      "-c",
      GATEWAY_UPGRADE_EXECUTABLE_DIRECTORY_SCRIPT,
      "/usr/local/bin",
      String(uid),
    ],
    { artifactName: "prepare-legacy-executable-directory", env, timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0 || result.signal || result.timedOut) {
    throw new Error(`Cannot prepare the legacy executable directory: ${resultText(result)}`);
  }
}
