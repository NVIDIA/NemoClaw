// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const requireSource = createRequire(import.meta.url);
const probe = requireSource("../scripts/cua-qualification-target-channel-probe.ts") as {
  KIND: string;
  MAX_RESPONSE_BYTES: number;
  PROTOCOL: string;
  REQUEST: string;
  parseIdentityFrame: (
    bytes: Buffer,
    expectedServiceBundle: string,
    expectedTargetImage: string,
  ) => Record<string, unknown>;
};

const serviceBundleDigest = `sha256:${"4".repeat(64)}`;
const targetImageDigest = `sha256:${"3".repeat(64)}`;

function identity(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: "1.0.0",
      kind: probe.KIND,
      protocol: probe.PROTOCOL,
      serviceBundleDigest,
      targetImageDigest,
      ...overrides,
    })}\n`,
  );
}

describe("CUA qualification target-channel identity probe", () => {
  it("accepts one exact content-free identity bound to the service tuple (#7755)", () => {
    expect(JSON.parse(probe.REQUEST)).toEqual({
      schemaVersion: "1.0.0",
      kind: "cua-qualification-target-channel-identity-request",
      protocol: "cua.qualification.target-channel/v1",
    });
    expect(probe.parseIdentityFrame(identity(), serviceBundleDigest, targetImageDigest)).toEqual({
      schemaVersion: "1.0.0",
      kind: probe.KIND,
      protocol: probe.PROTOCOL,
      serviceBundleDigest,
      targetImageDigest,
    });
  });

  it.each([
    ["missing newline", identity().subarray(0, identity().length - 1)],
    [
      "CRLF terminator",
      Buffer.concat([identity().subarray(0, identity().length - 1), Buffer.from("\r\n")]),
    ],
    ["leading JSON whitespace", Buffer.concat([Buffer.from(" "), identity()])],
    ["duplicate frame", Buffer.concat([identity(), identity()])],
    [
      "duplicate JSON key",
      Buffer.from(
        `{"schemaVersion":"1.0.0","schemaVersion":"1.0.0","kind":"${probe.KIND}","protocol":"${probe.PROTOCOL}","serviceBundleDigest":"${serviceBundleDigest}","targetImageDigest":"${targetImageDigest}"}\n`,
      ),
    ],
    ["trailing bytes", Buffer.concat([identity(), Buffer.from("x")])],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28, 0x0a])],
    ["oversized frame", Buffer.alloc(probe.MAX_RESPONSE_BYTES + 1, 0x20)],
    ["extra key", identity({ endpoint: "hidden" })],
    ["wrong protocol", identity({ protocol: "cua.qualification.target-channel/v2" })],
    ["wrong service bundle", identity({ serviceBundleDigest: `sha256:${"a".repeat(64)}` })],
    ["wrong target image", identity({ targetImageDigest: `sha256:${"b".repeat(64)}` })],
  ])("rejects a %s response before publishing identity (#7755)", (_label, response) => {
    expect(() =>
      probe.parseIdentityFrame(response, serviceBundleDigest, targetImageDigest),
    ).toThrow();
  });
});
