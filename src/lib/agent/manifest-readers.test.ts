// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseManifestRecord } from "./manifest-readers";

describe("agent manifest YAML merges", () => {
  it("preserves defaults and lets explicit values override merged values", () => {
    expect(
      parseManifestRecord(
        "defaults: &defaults {enabled: true, name: default}\nagent: {<<: *defaults, name: custom}\n",
        "merge.yaml",
      ),
    ).toEqual({
      defaults: { enabled: true, name: "default" },
      agent: { enabled: true, name: "custom" },
    });
  });

  it("accepts a merge sequence with 100 empty sources", () => {
    const sources = Array<string>(100).fill("*empty").join(", ");
    expect(
      parseManifestRecord(`empty: &empty {}\nagent: {<<: [${sources}]}\n`, "merge.yaml"),
    ).toEqual({ empty: {}, agent: {} });
  });

  it("rejects a merge sequence with more than 100 sources (#11252)", () => {
    const sources = Array<string>(101).fill("*empty").join(", ");
    expect(() =>
      parseManifestRecord(`empty: &empty {}\nagent: {<<: [${sources}]}\n`, "merge.yaml"),
    ).toThrow(/abnormal merge sequence size/);
  });

  it("accepts repeated empty merge sources at the document work limit", () => {
    const sources = Array<string>(100).fill("*empty").join(", ");
    const mappings = Array.from({ length: 100 }, (_, index) => `agent${index}: {<<: [${sources}]}`);
    const parsed = parseManifestRecord(`empty: &empty {}\n${mappings.join("\n")}\n`, "merge.yaml");

    expect(Object.keys(parsed)).toHaveLength(101);
    expect(parsed.agent99).toEqual({});
  });

  it("rejects repeated empty merge sources that exceed the document work limit (#11252)", () => {
    const sources = Array<string>(100).fill("*empty").join(", ");
    // Each sequence stays within its limit; 101 sequences exceed the 10,000-work document limit.
    const mappings = Array.from({ length: 101 }, (_, index) => `agent${index}: {<<: [${sources}]}`);
    expect(() =>
      parseManifestRecord(`empty: &empty {}\n${mappings.join("\n")}\n`, "merge.yaml"),
    ).toThrow(/merge keys exceeded maxTotalMergeKeys/);
  });
});
