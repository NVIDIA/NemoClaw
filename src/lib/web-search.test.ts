// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildWebSearchDockerConfig,
  getBraveExposureWarningLines,
} from "./web-search";

describe("web-search helpers", () => {
  it("emits empty docker config when web search is disabled", () => {
    expect(Buffer.from(buildWebSearchDockerConfig(null, null), "base64").toString("utf8")).toBe(
      "{}",
    );
  });

  it("emits empty docker config when fetchEnabled is false", () => {
    expect(
      Buffer.from(
        buildWebSearchDockerConfig({ fetchEnabled: false }, null),
        "base64",
      ).toString("utf8"),
    ).toBe("{}");
  });

  it("encodes Brave Search docker config including the api key", () => {
    const encoded = buildWebSearchDockerConfig({ fetchEnabled: true }, "brv-x");
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual({
      provider: "brave",
      fetchEnabled: true,
      apiKey: "brv-x",
    });
  });

  it("includes the explicit exposure caveat in the warning text", () => {
    const warning = getBraveExposureWarningLines().join(" ");
    expect(warning).toContain("sandbox agent config");
    expect(warning).toContain("sandboxed agent will be able to read");
  });
});
