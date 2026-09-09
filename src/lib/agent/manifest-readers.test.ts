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

  it("rejects repeated empty merge sources that exceed the document work limit (#11252)", () => {
    const sources = Array<string>(100).fill("*empty").join(", ");
    // Each sequence stays within its limit; 1,001 sequences exceed the 100,000-work document limit.
    const mappings = Array.from(
      { length: 1001 },
      (_, index) => `agent${index}: {<<: [${sources}]}`,
    );
    expect(() =>
      parseManifestRecord(`empty: &empty {}\n${mappings.join("\n")}\n`, "merge.yaml"),
    ).toThrow(/merge keys exceeded maxTotalMergeKeys/);
  });
});
