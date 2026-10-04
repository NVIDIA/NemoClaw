// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

type AsynchronousReplacementClock = {
  readonly handoffScheduled: () => boolean;
  readonly monotonicNow: () => number;
};

type SynchronousReplacementClock = {
  readonly acquisitionPublished: () => boolean;
  readonly monotonicNow: () => number;
  readonly replacementPublished: () => boolean;
};

function replaceLockGeneration(lockPath: string, token: string): void {
  const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
  fs.unlinkSync(lockPath);
  fs.writeFileSync(lockPath, `${JSON.stringify({ ...owner, token })}\n`);
}

export function createAsynchronousLockReplacementClock(
  lockPath: string,
  replacementToken: string,
): AsynchronousReplacementClock {
  let now = 0;
  let handoffScheduled = false;

  return {
    handoffScheduled: () => handoffScheduled,
    monotonicNow: () => {
      if (!handoffScheduled && fs.existsSync(lockPath)) {
        handoffScheduled = true;
        queueMicrotask(() => {
          replaceLockGeneration(lockPath, replacementToken);
          now = 100;
        });
      }
      return now;
    },
  };
}

export function createSynchronousLockReplacementClock(
  lockPath: string,
  replacementToken: string,
): SynchronousReplacementClock {
  let acquisitionPublished = false;
  let replacementPublished = false;

  return {
    acquisitionPublished: () => acquisitionPublished,
    monotonicNow: () => {
      if (!fs.existsSync(lockPath)) return 0;
      if (!acquisitionPublished) {
        acquisitionPublished = true;
        return 0;
      }
      if (!replacementPublished) {
        replaceLockGeneration(lockPath, replacementToken);
        replacementPublished = true;
      }
      return 100;
    },
    replacementPublished: () => replacementPublished,
  };
}
