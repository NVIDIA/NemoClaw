// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerSpawnSync, type DockerSpawnSyncOptions, type DockerSpawnSyncResult } from "./exec";

export function dockerLoginPasswordStdin(
  registry: string,
  username: string,
  password: string,
  opts: DockerSpawnSyncOptions = {},
): DockerSpawnSyncResult {
  return dockerSpawnSync(["login", registry, "-u", username, "--password-stdin"], {
    input: password,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  });
}
