// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type OpenshellExecArgOptions = {
  workdir?: string;
  tty?: boolean | null;
  timeoutSeconds?: number;
};

export function buildOpenshellExecArgs(
  sandboxName: string,
  command: readonly string[],
  options: OpenshellExecArgOptions = {},
  gatewayName?: string,
): string[] {
  const argv = ["sandbox", "exec", "--name", sandboxName];
  if (gatewayName) argv.push("-g", gatewayName);
  if (options.workdir) argv.push("--workdir", options.workdir);
  if (options.tty === true) argv.push("--tty");
  if (options.tty === false) argv.push("--no-tty");
  if (typeof options.timeoutSeconds === "number") {
    argv.push("--timeout", String(options.timeoutSeconds));
  }
  argv.push("--", ...command);
  return argv;
}
