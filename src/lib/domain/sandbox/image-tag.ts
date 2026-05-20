// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const BUILT_SANDBOX_IMAGE_RE = /Built image (openshell\/sandbox-from:\d+)/;

export function resolveSandboxImageTagFromCreateOutput(
  output: string,
  buildId: string,
  warn: (message: string) => void = console.warn,
): string {
  const builtImageMatch = output.match(BUILT_SANDBOX_IMAGE_RE);
  if (builtImageMatch?.[1]) {
    return builtImageMatch[1];
  }

  warn(
    "  Warning: could not parse image tag from build output; imageTag may be stale. Run 'nemoclaw gc' if destroy fails.",
  );
  return `openshell/sandbox-from:${buildId}`;
}
