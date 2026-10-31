// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Recognize only complete, structured absence from an owner-scoped sandbox operation. */
export function isStructuredUnqualifiedSandboxNotFoundOutput(
  output: string,
  options: { allowCompactStatus?: boolean } = {},
): boolean {
  const diagnostic = output
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/gu, "")
    .trim()
    .replace(/\n\s*│\s*/gu, " ");
  const match =
    /^(?:(?:error|rpc error):\s*)*(?:×\s*)?(code|status)\s*[:=]\s*(?:(['"`])([^'"`]+)\2|([a-z ]+))\s*,\s*message:\s*(['"`])([^'"`]+)\5$/iu.exec(
      diagnostic,
    );
  if (!match || match[6] !== "sandbox not found") return false;
  const value = (match[3] ?? match[4] ?? "").replace(/\s/gu, "").toLowerCase();
  if (match[1]?.toLowerCase() === "code") {
    return value === "notfound" || value === "somerequestedentitywasnotfound";
  }
  return (
    value === "notfound" &&
    (options.allowCompactStatus !== false || /not\s+found/iu.test(match[3] ?? match[4] ?? ""))
  );
}
