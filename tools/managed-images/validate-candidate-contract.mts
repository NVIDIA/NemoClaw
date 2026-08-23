// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validates one published candidate managed-image contract.
 *
 * Candidate publication reuses the shared managed-image contract parser, so a
 * candidate digest is held to the same exact identity rules as a shipped image.
 * The candidate agent must stay outside the shipped cohort: this validator
 * fails closed if a candidate contract claims a shipped agent.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isCandidateManagedImageAgent,
  isManagedImagePlatform,
  isShippedManagedImageAgent,
  type ManagedImageContractV1,
  parseManagedImageContractV1,
} from "../../src/lib/onboard/managed-image/contract.ts";

export function validateCandidateContract(
  value: unknown,
  platform: string,
): ManagedImageContractV1 {
  if (!isManagedImagePlatform(platform)) {
    throw new Error(`Unsupported candidate platform: ${platform}`);
  }
  const contract = parseManagedImageContractV1(value, undefined, platform);
  if (!isCandidateManagedImageAgent(contract.agent)) {
    throw new Error(`Agent '${contract.agent}' is not a candidate managed-image agent`);
  }
  if (isShippedManagedImageAgent(contract.agent)) {
    throw new Error(`Agent '${contract.agent}' is already shipped and cannot publish a candidate`);
  }
  return contract;
}

function readOption(argv: readonly string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function main(argv: readonly string[]): void {
  const contractPath = readOption(argv, "contract");
  const platform = readOption(argv, "platform");
  const contract = validateCandidateContract(
    JSON.parse(fs.readFileSync(contractPath, "utf8")),
    platform,
  );
  console.log(
    `Validated candidate contract for ${contract.agent} on ${contract.platform}: ${contract.reference}`,
  );
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main(process.argv.slice(2));
}
