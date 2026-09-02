// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CONTRACT_BYTES = 64 * 1024;
const EXPECTED_CONTRACT = {
  protocol: 1,
  ok: false,
  detail: "tool discovery received invalid runtime arguments",
} as const;

export function validateManagedImageDiscoveryContract(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("managed image discovery contract must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.protocol !== EXPECTED_CONTRACT.protocol ||
    record.ok !== EXPECTED_CONTRACT.ok ||
    record.detail !== EXPECTED_CONTRACT.detail
  ) {
    throw new Error("managed image discovery contract does not match the expected failure");
  }
}

export function parseManagedImageDiscoveryContract(source: string): void {
  if (Buffer.byteLength(source, "utf8") > MAX_CONTRACT_BYTES) {
    throw new Error("managed image discovery contract exceeds the size limit");
  }
  validateManagedImageDiscoveryContract(JSON.parse(source) as unknown);
}

export function main(): void {
  parseManagedImageDiscoveryContract(fs.readFileSync(0, "utf8"));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid discovery contract");
    process.exitCode = 1;
  }
}
