// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildForwardServiceArgs,
  classifyForwardServiceReceipt,
  forwardServiceReceiptPath,
  isForwardServiceReceipt,
  type ForwardServiceProcessObservation,
  type ForwardServiceReceipt,
  type ForwardServiceTarget,
} from "./forward-service";

const fingerprint = "a".repeat(64);
const target: ForwardServiceTarget = {
  executable: "/usr/local/bin/openshell",
  gatewayName: "nemoclaw",
  workspace: "default",
  sandboxName: "alpha",
  sandboxIdentityFingerprint: fingerprint,
  localHost: "127.0.0.1",
  localPort: 18_789,
  targetHost: "127.0.0.1",
  targetPort: 18_789,
};
const argv = [target.executable, ...buildForwardServiceArgs(target)];
const receipt: ForwardServiceReceipt = {
  schemaVersion: 1,
  ...target,
  pid: 4242,
  uid: 501,
  processIdentity: "macos:Mon Aug 31 09:00:00 2026",
  hostIdentity: "darwin:test-host",
  pidNamespaceIdentity: null,
  argv,
  startedAt: "2026-08-31T16:00:00.000Z",
};
const observation: ForwardServiceProcessObservation = {
  alive: true,
  uid: receipt.uid,
  processIdentity: receipt.processIdentity,
  hostIdentity: receipt.hostIdentity,
  pidNamespaceIdentity: receipt.pidNamespaceIdentity,
  argv,
};

describe("OpenShell ForwardTcp service contract (#10691)", () => {
  it("builds an explicit gateway-scoped direct ForwardTcp command", () => {
    expect(buildForwardServiceArgs(target)).toEqual([
      "--gateway",
      "nemoclaw",
      "--workspace",
      "default",
      "forward",
      "service",
      "alpha",
      "--target-port",
      "18789",
      "--target-host",
      "127.0.0.1",
      "--local",
      "127.0.0.1:18789",
    ]);
  });

  it("keeps explicit remote exposure in the local bind only", () => {
    expect(buildForwardServiceArgs({ ...target, localHost: "0.0.0.0" })).toContain("0.0.0.0:18789");
    expect(buildForwardServiceArgs({ ...target, localHost: "0.0.0.0" })).toContain("127.0.0.1");
  });

  it.each([
    ["relative executable", { executable: "openshell" }],
    ["foreign gateway", { gatewayName: "production" }],
    ["non-default workspace", { workspace: "other" }],
    ["numeric sandbox prefix", { sandboxName: "1-alpha" }],
    ["unsafe sandbox name", { sandboxName: "../alpha" }],
    ["missing sandbox identity", { sandboxIdentityFingerprint: "" }],
    ["remote target", { targetHost: "0.0.0.0" }],
    ["invalid local port", { localPort: 0 }],
    ["invalid target port", { targetPort: 65_536 }],
  ] as const)("rejects %s before process launch", (_name, patch) => {
    expect(() => buildForwardServiceArgs({ ...target, ...patch } as ForwardServiceTarget)).toThrow(
      /OpenShell forward service/u,
    );
  });

  it("derives the receipt path from validated sandbox and port values", () => {
    expect(forwardServiceReceiptPath("/private/state", target)).toBe(
      path.join("/private/state", "forwards", "alpha-18789.json"),
    );
    expect(() => forwardServiceReceiptPath("relative", target)).toThrow(/must be absolute/u);
  });

  it("accepts only the exact credential-free receipt schema", () => {
    expect(isForwardServiceReceipt(receipt)).toBe(true);
    expect(isForwardServiceReceipt({ ...receipt, token: "secret" })).toBe(false);
    expect(
      isForwardServiceReceipt({ ...receipt, argv: [...receipt.argv, "--gateway-endpoint"] }),
    ).toBe(false);
  });

  it("accepts a live process only when every authority field matches", () => {
    expect(classifyForwardServiceReceipt(receipt, target, observation)).toBe("owned");
  });

  it("treats a dead recorded process as stale", () => {
    expect(classifyForwardServiceReceipt(receipt, target, { ...observation, alive: false })).toBe(
      "stale",
    );
  });

  it.each([
    ["UID", { uid: 502 }],
    ["start identity", { processIdentity: "macos:replacement" }],
    ["arguments", { argv: [...argv.slice(0, -1), "127.0.0.1:18790"] }],
  ] as const)("does not adopt a process after %s reuse", (_name, patch) => {
    expect(
      classifyForwardServiceReceipt(receipt, target, {
        ...observation,
        ...patch,
      } as ForwardServiceProcessObservation),
    ).toBe("stale");
  });

  it("fails closed when live process identity cannot be read", () => {
    expect(
      classifyForwardServiceReceipt(receipt, target, {
        ...observation,
        processIdentity: null,
      }),
    ).toBe("unknown");
  });

  it("rejects a receipt from another host or PID namespace", () => {
    expect(
      classifyForwardServiceReceipt(receipt, target, {
        ...observation,
        hostIdentity: "darwin:other-host",
      }),
    ).toBe("foreign");
    expect(
      classifyForwardServiceReceipt({ ...receipt, pidNamespaceIdentity: "pid:[1]" }, target, {
        ...observation,
        pidNamespaceIdentity: "pid:[2]",
      }),
    ).toBe("foreign");
  });

  it("rejects a receipt for a replaced same-name sandbox", () => {
    expect(
      classifyForwardServiceReceipt(
        receipt,
        {
          ...target,
          sandboxIdentityFingerprint: "b".repeat(64),
        },
        observation,
      ),
    ).toBe("foreign");
  });
});
