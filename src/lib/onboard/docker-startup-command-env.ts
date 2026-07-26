// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const STARTUP_COMMAND_TOKEN = /^[A-Za-z0-9_./:=,@%+\-\[\]]+$/u;

export function openshellSandboxCommandEnvValue(
  command: readonly string[] | null | undefined,
): string | null {
  const parts = (command || []).map(String);
  if (parts.length === 0) return null;
  if (parts.some((part) => part.length === 0 || /[\s\u0085]/u.test(part))) {
    throw new Error(
      "OpenShell sandbox startup command tokens cannot be empty or contain whitespace.",
    );
  }
  if (parts.some((part) => !STARTUP_COMMAND_TOKEN.test(part))) {
    throw new Error(
      "OpenShell sandbox startup command tokens contain unsupported shell metacharacters.",
    );
  }
  return parts.join(" ");
}
