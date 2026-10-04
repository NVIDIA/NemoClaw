// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import dns from "node:dns/promises";
import childProcess from "node:child_process";

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

/** Isolate getaddrinfo so a deadline can terminate it while retaining host resolver semantics. */
export function resolveHostAddressesBounded(
  hostname: string,
  timeoutMs: number,
): Promise<DnsLookupAddress[]> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      process.execPath,
      [
        "-e",
        `
require("node:dns").lookup(process.argv[1], { all: true, verbatim: true }, (error, addresses) => {
  if (error) { process.exitCode = 1; return; }
  process.stdout.write(JSON.stringify(addresses));
});
`,
        "--",
        hostname,
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
      },
      (error, stdout) => {
        if (error) {
          reject(new Error(error.killed ? "DNS lookup timed out." : "DNS lookup failed."));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as DnsLookupAddress[]);
        } catch {
          reject(new Error("DNS lookup returned an invalid result."));
        }
      },
    );
  });
}
