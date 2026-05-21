// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ForwardStopRunner = (
  args: string[],
  opts: { ignoreError?: boolean; suppressOutput?: boolean },
) => unknown;

export function bestEffortForwardStop(
  runOpenshell: ForwardStopRunner,
  port: string | number,
): void {
  runOpenshell(["forward", "stop", String(port)], {
    ignoreError: true,
    suppressOutput: true,
  });
}
