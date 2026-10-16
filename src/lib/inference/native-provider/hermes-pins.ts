// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";
import { isPrivateIp } from "../../private-networks";

/** Durable Hermes policy accepts exact public IPs, never CIDRs or private ranges. */
export function requireHermesPublicPins(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((ip) => typeof ip !== "string" || !isIP(ip) || ip.includes("%") || isPrivateIp(ip))
  )
    throw new Error("Hermes endpoint requires recorded public IP addresses");
  return [...new Set(value as string[])].sort();
}
