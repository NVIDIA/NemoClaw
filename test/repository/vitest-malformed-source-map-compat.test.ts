// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { extractSourcemapFromFile } from "@vitest/utils/source-map/node";
import { expect } from "vitest";

import { test as it } from "../helpers/owned-test-resources";

it("ignores a malformed inline source map marker embedded in module text", () => {
  const marker = ["//# sourceMapping", "URL=data:application/json;base64,", "bm90LWpzb24="].join(
    "",
  );
  const source = `const embeddedSourceMapComment = ${JSON.stringify(`\n${marker}\n`)};`;

  expect(extractSourcemapFromFile(source, "/tmp/tsx-bundle.mjs")).toBeUndefined();
});
