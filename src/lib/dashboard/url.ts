// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isLoopbackHostname } from "../core/url-utils.ts";

/** Classify a validated dashboard URL with the repository-wide loopback policy. */
export function isLoopbackDashboardUrl(value: string): boolean {
  return isLoopbackHostname(new URL(value).hostname);
}

/** Rebind a loopback dashboard URL without changing a proxy-owned external URL. */
export function rebindLoopbackDashboardUrlPort(value: string, port: number): string {
  if (!isLoopbackDashboardUrl(value)) return value;
  const parsed = new URL(value);
  parsed.port = String(port);
  return parsed.toString();
}
