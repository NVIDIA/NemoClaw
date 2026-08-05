// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { probeContainerDns } from "./preflight";

const BUSYBOX_NO_DATA =
  "Server:\t\t192.168.5.3\n" +
  "Address:\t192.168.5.3:53\n" +
  "\n" +
  "Non-authoritative answer:\n" +
  "\n" +
  "Non-authoritative answer:\n";

describe("probeContainerDns NOERROR/NODATA handling", () => {
  it("accepts exit-zero NOERROR/NODATA from an enterprise resolver (#7937)", () => {
    const result = probeContainerDns({
      executionOverride: {
        stdout: BUSYBOX_NO_DATA,
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("rejects a nonzero NODATA-shaped response (#7937)", () => {
    const result = probeContainerDns({
      executionOverride: {
        stdout: BUSYBOX_NO_DATA,
        stderr: "",
        exitCode: 1,
        signal: null,
        timedOut: false,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("resolution_failed");
  });

  it.each([
    [
      "SERVFAIL",
      "Server:\t\t192.168.5.3\n" +
        "Address:\t192.168.5.3:53\n\n" +
        "** server can't find nemoclaw.invalid: SERVFAIL\n",
    ],
    [
      "REFUSED",
      "Server:\t\t192.168.5.3\n" +
        "Address:\t192.168.5.3:53\n\n" +
        "** server can't find nemoclaw.invalid: REFUSED\n",
    ],
    [
      "one answer marker",
      "Server:\t\t192.168.5.3\n" + "Address:\t192.168.5.3:53\n\n" + "Non-authoritative answer:\n",
    ],
    [
      "missing resolver address",
      "Server:\t\t192.168.5.3\n" +
        "Address:\n\n" +
        "Non-authoritative answer:\n\n" +
        "Non-authoritative answer:\n",
    ],
  ])("rejects exit-zero malformed NODATA output: %s (#7937)", (_label, stdout) => {
    const result = probeContainerDns({
      executionOverride: {
        stdout,
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("resolution_failed");
  });
});
