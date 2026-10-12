// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import childProcess, {
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";

import { type DnsLookupAll, resolveHostAddresses, resolveHostAddressesBounded } from "./resolve";

describe("DNS resolver adapter", () => {
  it("resolves through an isolated host resolver with a deadline (#10464)", async () => {
    await expect(resolveHostAddressesBounded("127.0.0.1", 2_000)).resolves.toEqual([
      { address: "127.0.0.1", family: 4 },
    ]);
  });

  it("terminates a stalled resolver process before releasing its slot (#10464)", async () => {
    const exec = childProcess.execFile;
    let child: ChildProcess | undefined;
    const stalled = (
      binary: string,
      _args: readonly string[],
      options: ExecFileOptionsWithStringEncoding,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => {
      child = exec(
        binary,
        ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);'],
        options,
        callback,
      );
      return child;
    };
    const spy = vi
      .spyOn(childProcess, "execFile")
      .mockImplementationOnce(stalled as typeof childProcess.execFile);
    try {
      await expect(resolveHostAddressesBounded("stalled.example.test", 100)).rejects.toThrow(
        "DNS lookup timed out",
      );
      expect(child?.signalCode).toBe("SIGKILL");
    } finally {
      spy.mockRestore();
    }
  });

  it("requests all addresses in resolver order through the injected lookup", async () => {
    const addresses = [
      { address: "203.0.113.10", family: 4 },
      { address: "2001:db8::10", family: 6 },
    ];
    const lookup = vi.fn<DnsLookupAll>().mockResolvedValue(addresses);

    await expect(resolveHostAddresses("mcp.example.test", lookup)).resolves.toEqual(addresses);
    expect(lookup).toHaveBeenCalledWith("mcp.example.test", {
      all: true,
      verbatim: true,
    });
  });
});
