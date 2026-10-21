// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  OPENCLAW_SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY,
  PINNED_HERMES_BASE_SECURITY_PACKAGE_INVENTORY,
  SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY,
  securityInventoryProbe,
} from "../../src/lib/sandbox-base-image/security-package-specs.ts";

const [operation, profile, architecture] = process.argv.slice(2);
if (!["shared", "openclaw", "hermes-compatible"].includes(profile ?? "")) {
  throw new Error("Expected shared, openclaw, or hermes-compatible package profile");
}
const inventory =
  profile === "openclaw"
    ? OPENCLAW_SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY
    : SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY;
switch (operation) {
  case "inventory":
    if (architecture !== "amd64" && architecture !== "arm64") {
      throw new Error("Expected amd64 or arm64 package architecture");
    }
    process.stdout.write([`architecture=${architecture}`, ...inventory, ""].join("\n"));
    break;
  case "probe":
    process.stdout.write(
      securityInventoryProbe(
        inventory,
        profile === "hermes-compatible" ? PINNED_HERMES_BASE_SECURITY_PACKAGE_INVENTORY : undefined,
      ) + "\n",
    );
    break;
  default:
    throw new Error("Expected inventory or probe operation");
}
