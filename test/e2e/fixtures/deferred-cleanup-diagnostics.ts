// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderPrerequisite } from "./runtime-provider.ts";

export async function captureDeferredPodmanCleanupOwnership(
  runtime: Pick<RuntimeProviderPrerequisite, "id" | "execSandboxAsRoot">,
  options: {
    agent: string;
    destroyed: boolean;
    redactionValues: string[];
    sandboxName: string;
  },
): Promise<void> {
  if (options.destroyed || options.agent !== "langchain-deepagents-code" || runtime.id !== "podman")
    return;

  const metadata = [
    "id",
    "for path in /sandbox /sandbox/.openclaw /sandbox/.openclaw/workspace /sandbox/.openclaw/workspace/POLICY.md; do",
    '  stat -c "%n uid=%u gid=%g mode=%a dev=%d inode=%i type=%F" "$path" || true',
    "done",
  ].join("\n");
  await runtime
    .execSandboxAsRoot(options.sandboxName, ["sh", "-c", metadata], {
      artifactName: "deferred-dcode-podman-cleanup-root-metadata",
      redactionValues: options.redactionValues,
      sanitizeEnvironment: true,
      captureLimitBytes: 4096,
      timeoutMs: 10_000,
    })
    .catch(() => undefined);
}
