// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lookup } from "node:dns/promises";

/**
 * Resolve all A/AAAA addresses for a hostname. A thin, stubbable wrapper around
 * `node:dns/promises` `lookup(host, { all: true })` so callers (e.g. the
 * custom-endpoint SSRF preflight wired in onboard.ts) can depend on a repo
 * module that tests can override — builtin module exports are non-writable and
 * cannot be monkeypatched.
 */
export async function resolveHostAddresses(
  hostname: string,
  options: { all: true },
): Promise<Array<{ address: string; family?: number }>> {
  return lookup(hostname, options);
}
