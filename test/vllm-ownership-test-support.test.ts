// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createStrictVllmOwnershipCapture } from "./support/vllm-ownership-test-support";

describe("vLLM ownership test capture", () => {
  it("consumes explicit canonical and ambient ownership responses", () => {
    const capture = createStrictVllmOwnershipCapture(
      [() => "canonical", () => "ambient"],
      "builder",
      (command) => `fallback:${command}`,
    );

    expect(capture(["container"], { env: { DOCKER_CONTEXT: "default" } })).toBe("canonical");
    expect(capture(["container"], { env: { DOCKER_CONTEXT: "builder" } })).toBe("ambient");
    expect(capture(["ps"])).toBe("fallback:ps");
  });

  it("preserves explicit absence but rejects ownership response exhaustion", () => {
    const capture = createStrictVllmOwnershipCapture([() => ""], "ambient", () => "");

    expect(capture(["container"], { env: { DOCKER_CONTEXT: "default" } })).toBe("");
    expect(() => capture(["container"])).toThrow("Unexpected extra vLLM ownership inspection");
  });

  it("rejects ownership inspection through an unregistered Docker context", () => {
    const capture = createStrictVllmOwnershipCapture([() => ""], "ambient", () => "");

    expect(() => capture(["container"], { env: { DOCKER_CONTEXT: "surprise" } })).toThrow(
      "Unexpected vLLM ownership inspection context: surprise",
    );
  });
});
