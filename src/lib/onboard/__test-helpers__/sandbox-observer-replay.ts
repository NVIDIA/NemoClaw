// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import type {
  OpenShellSandboxObserver,
  OpenShellSandboxReadiness,
} from "../../adapters/openshell/sandbox-observer";

export type SandboxObservationFrame = Readonly<{
  phase: string | null;
  readiness: OpenShellSandboxReadiness;
}> | null;

export function readySandboxFrame(phase = "Ready"): SandboxObservationFrame {
  return { phase, readiness: "ready" };
}

export function pendingSandboxFrame(phase: string): SandboxObservationFrame {
  return { phase, readiness: "not_ready" };
}

export function terminalSandboxFrame(phase: string | null): SandboxObservationFrame {
  return { phase, readiness: "terminal" };
}

export function replaySandboxObservations(
  sandboxName: string,
  frames: readonly SandboxObservationFrame[],
) {
  let index = 0;
  const listSandboxes = vi.fn<OpenShellSandboxObserver["listSandboxes"]>(async () => {
    const frame = frames[Math.min(index++, frames.length - 1)] ?? null;
    return {
      ok: true,
      value: {
        sandboxes: frame ? [{ name: sandboxName, ...frame }] : [],
      },
    };
  });
  return {
    observer: { listSandboxes },
    listSandboxes,
    sleep: vi.fn(),
    polls: () => index,
  };
}
