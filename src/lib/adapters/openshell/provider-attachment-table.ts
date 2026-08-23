// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stripAnsi } from "./ansi";

/** Parse the provider names from `openshell sandbox provider list`. */
export function parseProviderAttachmentNames(output: string): string[] {
  const clean = stripAnsi(output).replace(/\r/g, "").trim();
  if (/^No providers attached to sandbox\b/m.test(clean)) return [];
  const lines = clean
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex((line) =>
    /^NAME\s+TYPE\s+CREDENTIAL_KEYS\s+CONFIG_KEYS$/.test(line),
  );
  if (headerIndex < 0) throw new Error("missing provider attachment table header");
  return lines.slice(headerIndex + 1).map((line) => {
    const match = line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)$/);
    if (!match?.[1]) throw new Error("invalid provider attachment table row");
    return match[1];
  });
}
