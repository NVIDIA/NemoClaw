// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { extractShellFunction } from "./hermes-shell-harness";
import { extractShellFunctionFromSource } from "./shell-function-extractor";

describe("shell function extraction diagnostics", () => {
  it("names the Hermes source when the requested function is absent", () => {
    expect(() => extractShellFunction("", "missing_function")).toThrow(
      "Expected missing_function in agents/hermes/start.sh",
    );
  });

  it("uses the supplied source label when the closing brace is absent", () => {
    expect(() =>
      extractShellFunctionFromSource("broken() {\n", "broken", "fixtures/broken.sh"),
    ).toThrow("Expected closing brace for broken in fixtures/broken.sh");
  });
});
