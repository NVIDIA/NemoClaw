// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

interface DockerCaptureTestOptions {
  readonly env?: NodeJS.ProcessEnv;
}

type OwnershipResponse = () => string;

/** Route every ownership inspection explicitly and fail closed on fixture drift. */
export function createStrictVllmOwnershipCapture(
  ownershipResponses: readonly OwnershipResponse[],
  ambientContext: string,
  fallback: (command: string) => string,
): (args: readonly string[], options?: DockerCaptureTestOptions) => string {
  const queue = [...ownershipResponses];
  const allowedContexts = new Set(["default", ambientContext]);
  return (args, options) => {
    const command = args[0] ?? "";
    if (command !== "container") return fallback(command);

    const context = options?.env?.DOCKER_CONTEXT ?? "ambient";
    if (!allowedContexts.has(context)) {
      throw new Error(`Unexpected vLLM ownership inspection context: ${context}`);
    }
    const response = queue.shift();
    if (!response) throw new Error("Unexpected extra vLLM ownership inspection");
    return response();
  };
}
