// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const ANSI_RE = /\x1b\[[0-9;]*m/gu;
const SANDBOX_ID_RE = /^[A-Za-z0-9._-]+$/u;

export function parseOpenShellSandboxId(output: string): string | null {
  const matches = [
    ...String(output)
      .replace(ANSI_RE, "")
      .matchAll(/^\s*(?:Id|ID):\s*(\S+)\s*$/gm),
  ].map((match) => match[1] ?? "");
  return matches.length === 1 && SANDBOX_ID_RE.test(matches[0] as string)
    ? (matches[0] as string)
    : null;
}
