// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildDnsProxyPython,
  buildDnsReadyProbePython,
  buildResolvConf,
  isSafeDnsAddress,
  parseVethGateway,
  selectSandboxNamespace,
  selectSandboxPod,
} from "../../../../dist/lib/domain/dns/setup-proxy.js";

describe("DNS setup proxy domain helpers", () => {
  it("selects a sandbox pod using fixed-string style matching", () => {
    expect(selectSandboxPod("box[1]", "pod/alpha\npod/box[1]-abc\n")).toBe("box[1]-abc");
    expect(selectSandboxPod("missing", "pod/alpha\n")).toBeNull();
  });

  it("falls back to the default veth gateway when discovery is empty", () => {
    expect(parseVethGateway("10.200.0.1\n")).toBe("10.200.0.1");
    expect(parseVethGateway("\n")).toBe("10.200.0.1");
  });

  it("selects the first sandbox namespace", () => {
    expect(selectSandboxNamespace("other\nsandbox-ns\n")).toBe("sandbox-ns");
    expect(selectSandboxNamespace("other\n")).toBeNull();
  });

  it("builds checked-in DNS proxy payloads and resolv.conf content", () => {
    expect(buildDnsProxyPython()).toContain("sock.bind((BIND_IP, 53))");
    expect(buildDnsReadyProbePython("10.200.0.1")).toContain("10.200.0.1");
    expect(buildResolvConf("10.200.0.1")).toBe("nameserver 10.200.0.1\noptions ndots:5\n");
  });

  it("rejects unsafe DNS address strings", () => {
    expect(isSafeDnsAddress("10.43.0.10")).toBe(true);
    expect(isSafeDnsAddress("bad;rm")).toBe(false);
  });
});
