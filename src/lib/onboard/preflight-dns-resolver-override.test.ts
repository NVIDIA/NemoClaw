// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { probeContainerDns } from "./preflight";

describe("probeContainerDns resolver override (#7172)", () => {
  it("tests the recreated sandbox DNS path with the selected resolver", () => {
    let seenScript = "";
    probeContainerDns({
      dnsServer: "169.254.169.253",
      probeName: "pinned-test.invalid",
      runCaptureImpl: (command) => {
        seenScript = command[2] ?? "";
        return "Name:\tpinned-test.invalid\nAddress: 1.2.3.4\n";
      },
    });

    expect(seenScript).toContain("docker run --rm --pull=missing --dns 169.254.169.253 ");
    expect(seenScript).toContain("nslookup pinned-test.invalid");
  });

  it("preserves Docker defaults when no fallback resolver is provided", () => {
    let seenScript = "";
    probeContainerDns({
      probeName: "pinned-test.invalid",
      runCaptureImpl: (command) => {
        seenScript = command[2] ?? "";
        return "Name:\tpinned-test.invalid\nAddress: 1.2.3.4\n";
      },
    });

    expect(seenScript).not.toContain("--dns");
  });

  it("rejects a non-IP resolver before building the shell command", () => {
    const runCaptureImpl = vi.fn(() => "");
    expect(() => probeContainerDns({ dnsServer: "8.8.8.8; rm -rf /", runCaptureImpl })).toThrow(
      /dnsServer must be an IP address/,
    );
    expect(runCaptureImpl).not.toHaveBeenCalled();
  });
});
