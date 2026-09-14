// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseManifestRecord } from "./manifest-readers";

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
