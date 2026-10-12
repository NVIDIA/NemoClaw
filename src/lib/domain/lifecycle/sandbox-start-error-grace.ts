// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// OpenShell can transiently report Error after start before advancing to Ready.
// Opt into twenty initial Error observations only after starting the sandbox;
// observing another phase ends the grace. Remove this compatibility exception
// when OpenShell exposes a structured restart signal or guarantees that restart
// recovery never emits the terminal Error phase.
const START_INITIAL_ERROR_GRACE_POLLS = 20;

export function createSandboxStartErrorGrace(
  enabled: boolean,
): (phase: string | null | undefined) => boolean {
  let remainingPolls = enabled ? START_INITIAL_ERROR_GRACE_POLLS : 0;
  return (phase) => {
    const allowed = phase?.toLowerCase() === "error" && remainingPolls > 0;
    remainingPolls = allowed ? remainingPolls - 1 : 0;
    return allowed;
  };
}
