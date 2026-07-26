// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  StreamSandboxCreateOptions,
  StreamSandboxCreateResult,
} from "../../sandbox/create-stream";

export type SnapshotStreamSandboxCreateMock = (
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  options?: StreamSandboxCreateOptions,
) => Promise<StreamSandboxCreateResult>;
