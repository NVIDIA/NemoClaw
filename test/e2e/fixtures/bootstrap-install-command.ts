// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** sudo may discard its environment; only nonsecret bootstrap inputs belong in argv. */
export function bootstrapInstallSudoArgs(options: {
  script: string;
  cloneDir: string;
  installLog: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  return [
    "-n",
    "env",
    `LAUNCH_LOG=${options.installLog}`,
    `NEMOCLAW_CLONE_DIR=${options.cloneDir}`,
    "NEMOCLAW_REF=main",
    `SKIP_DOCKER_PULL=${options.env.SKIP_DOCKER_PULL ?? "1"}`,
    `NEMOCLAW_OPENSHELL_CHANNEL=${options.env.NEMOCLAW_OPENSHELL_CHANNEL ?? "stable"}`,
    "bash",
    options.script,
  ];
}
