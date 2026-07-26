// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import dns from "node:dns/promises";

export type DnsLookupAddress = { address: string; family: number };
export type DnsLookupAll = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<DnsLookupAddress[]>;

export async function resolveHostAddresses(
  hostname: string,
  lookup: DnsLookupAll = dns.lookup as DnsLookupAll,
): Promise<DnsLookupAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}
