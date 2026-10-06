// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import {
  parseProtectedManagedImageContracts,
  type ProtectedManagedImagePlatform,
} from "../../scripts/checks/protected-managed-image-contract.ts";

export function openclawProtectedImage(): string {
  const directImage = process.env.NEMOCLAW_TEST_IMAGE;
  if (directImage) return directImage;
  const platform = process.env
    .NEMOCLAW_PROTECTED_MANAGED_IMAGE_PLATFORM as ProtectedManagedImagePlatform;
  const contractFile = process.env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT ?? "";
  const contracts = parseProtectedManagedImageContracts(
    JSON.parse(fs.readFileSync(contractFile, "utf8")),
    platform,
  );
  const openclaw = contracts.find(({ agent }) => agent === "openclaw");
  if (!openclaw) throw new Error("protected managed-image contract has no OpenClaw image");
  return openclaw.reference;
}
