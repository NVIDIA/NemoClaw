// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { parseProtectedManagedImageContracts } from "../../../scripts/checks/protected-managed-image-contract.ts";
import { protectedManagedImageDispatchEnvironment } from "./managed-image-multiarch-startup-helpers.ts";

export const DANGEROUS_CAPABILITY_BITS = [21, 19, 13, 10, 7, 6, 3, 1] as const;

export function openclawProtectedImage(): string {
  const dispatch = protectedManagedImageDispatchEnvironment();
  const contracts = parseProtectedManagedImageContracts(
    JSON.parse(fs.readFileSync(dispatch.contractFile, "utf8")),
    dispatch.platform,
  );
  const openclaw = contracts.find(({ agent }) => agent === "openclaw");
  if (!openclaw) throw new Error("protected managed-image contract has no OpenClaw image");
  return openclaw.reference;
}

export function absentDangerousCapabilityBits(value: bigint): readonly number[] {
  return DANGEROUS_CAPABILITY_BITS.filter((bit) => (value & (1n << BigInt(bit))) === 0n);
}
