// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildWebSearchDockerConfig,
} from "./web-search";

describe("web-search helpers", () => {
  it("emits empty docker config when web search is disabled", () => {
    expect(Buffer.from(buildWebSearchDockerConfig(null), "base64").toString("utf8")).toBe(
      "{}",
    );
  });

  it("emits empty docker config when fetchEnabled is false", () => {
    expect(
      Buffer.from(
        buildWebSearchDockerConfig({ fetchEnabled: false }),
        "base64",
      ).toString("utf8"),
    ).toBe("{}");
  });

  it("encodes Brave Search docker config using proxy placeholder for api key", () => {
    const encoded = buildWebSearchDockerConfig({ fetchEnabled: true });
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual({
      provider: "brave",
      fetchEnabled: true,
      apiKey: "openshell:resolve:env:BRAVE_API_KEY",
    });
  });
});
