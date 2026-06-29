// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

export function spawnExitCode(result: {
  status: number | null;
  signal?: NodeJS.Signals | null;
}): number {
  if (result.status !== null) return result.status;
  if (!result.signal) return 1;
  const signalNumber = os.constants.signals[result.signal];
  return signalNumber ? 128 + signalNumber : 1;
}
