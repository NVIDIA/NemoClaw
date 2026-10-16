// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseManifestRecord } from "./manifest-readers";

describe("agent manifest YAML merges", () => {
  it("rejects repeated empty merges that exceed the parsing budget", () => {
    const emptyMappings = `${"{}, ".repeat(99)}{}`;
    const source = `mappings: &empty [${emptyMappings}]\ntargets:\n${"  - <<: *empty\n".repeat(101)}`;

    expect(() => parseManifestRecord(source, "empty-merge-budget")).toThrow(
      /merge keys exceeded maxTotalMergeKeys \(10000\)/,
    );
  });

  it("accepts 100 merge sources and rejects a longer sequence", () => {
    const allowed = `target: { <<: [${"{}, ".repeat(99)}{}] }`;
    const oversized = `target: { <<: [${"{}, ".repeat(100)}{}] }`;

    expect(parseManifestRecord(allowed, "bounded-merge-sequence")).toEqual({ target: {} });
    expect(() => parseManifestRecord(oversized, "oversized-merge-sequence")).toThrow(
      /abnormal merge sequence size/,
    );
  });

  it("preserves ordinary merge precedence and explicit manifest values", () => {
    const source = `defaults: &defaults { name: default, color: green }
fallback: &fallback { name: fallback, enabled: true }
agent:
  <<: [*defaults, *fallback]
  color: blue
`;

    expect(parseManifestRecord(source, "ordinary-merge").agent).toEqual({
      name: "default",
      color: "blue",
      enabled: true,
    });
  });
});

describe("agent manifest parsing", () => {
  it("rejects an oversized sequence of empty merge sources", () => {
    const anchors = Array.from({ length: 101 }, (_, index) => `empty${index}: &empty${index} {}`);
    const aliases = Array.from({ length: 101 }, (_, index) => `*empty${index}`);
    const manifest = [...anchors, "agent:", `  <<: [${aliases.join(", ")}]`].join("\n");

    expect(() => parseManifestRecord(manifest, "untrusted manifest")).toThrow(
      "abnormal merge sequence size",
    );
  });
});
