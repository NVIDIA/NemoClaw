// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import convertSourceMap from "convert-source-map";
import { describe, expect, it } from "vitest";

import {
  type ConvertSourceMapApi,
  installVitestMalformedSourceMapGuard,
} from "./vitest-malformed-source-map-guard";

const guardedSourceMap = convertSourceMap as ConvertSourceMapApi;

describe("Vitest malformed source map guard", () => {
  it("treats malformed inline and external maps as unavailable", () => {
    installVitestMalformedSourceMapGuard(guardedSourceMap);
    installVitestMalformedSourceMapGuard(guardedSourceMap);

    const embeddedMap = [
      "const embeddedSourceMapComment = `",
      "//# sourceMappingURL=data:application/json;base64,bm90LWpzb24=",
      "`;",
    ].join("\n");
    expect(guardedSourceMap.fromSource(embeddedMap)).toBeNull();
    expect(
      guardedSourceMap.fromMapFileSource("//# sourceMappingURL=external.js.map", () => "not-json"),
    ).toBeNull();
  });

  it("preserves valid inline source maps", () => {
    const sourceMap = {
      version: 3,
      file: "generated.js",
      names: [],
      sources: ["source.ts"],
      mappings: "AAAA",
    };
    const encodedMap = Buffer.from(JSON.stringify(sourceMap), "utf8").toString("base64");

    expect(
      guardedSourceMap
        .fromSource(`//# sourceMappingURL=data:application/json;base64,${encodedMap}`)
        ?.toObject(),
    ).toEqual(sourceMap);
  });
});
