// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { type CommandRunner } from "../fixtures/clients/command.ts";
import { HostCliClient } from "../fixtures/clients/host.ts";
import { discoverHostAddress, parseHostAddressProbe } from "../fixtures/host-address.ts";

describe("host address discovery", () => {
  it.each([
    ["route 10.0.0.2\n", { source: "route", address: "10.0.0.2" }],
    ["hostname 192.168.1.5\n", { source: "hostname", address: "192.168.1.5" }],
    ["darwin-interface 192.168.64.1\n", { source: "darwin-interface", address: "192.168.64.1" }],
    ["darwin-ifconfig 10.1.2.3\n", { source: "darwin-ifconfig", address: "10.1.2.3" }],
    ["loopback 127.0.0.1\n", { source: "loopback", address: "127.0.0.1" }],
  ])("parses %j", (output, expected) => expect(parseHostAddressProbe(output)).toEqual(expected));

  it("rejects successful unrecognized host address probe output", () => {
    expect(() => parseHostAddressProbe("garbage 10.0.0.2\n")).toThrow(
      /unrecognized probe output: garbage 10\.0\.0\.2/,
    );
  });

  it("rejects malformed known-source host address output", () => {
    expect(() => parseHostAddressProbe("route not-an-ip\n")).toThrow(
      /invalid IPv4 address from route: not-an-ip/,
    );
  });

  it("rejects failed host probes before parsing fallback output", async () => {
    const runner: CommandRunner = {
      run: async (command) => ({
        command: [command.command, ...command.args],
        exitCode: 127,
        signal: null,
        timedOut: false,
        stdout: "loopback 127.0.0.1\n",
        stderr: "bash: command not found\n",
        artifacts: { stdout: "stdout.txt", stderr: "stderr.txt", result: "result.json" },
      }),
    };

    await expect(discoverHostAddress(new HostCliClient(runner))).rejects.toThrow(
      /host address discovery failed/,
    );
  });
});
