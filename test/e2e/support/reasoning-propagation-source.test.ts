// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { reasoningPropagationSource } from "../fixtures/reasoning-propagation.ts";

describe("cloud onboarding reasoning propagation source", () => {
  it("uses the managed startup environment for managed images", () => {
    expect(reasoningPropagationSource("managed-image")).toEqual({
      kind: "managed-runtime-environment",
      path: "/run/nemoclaw/managed-startup-runtime.env",
    });
  });

  it("uses the image environment for the legacy Dockerfile fallback", () => {
    expect(reasoningPropagationSource("legacy-dockerfile")).toEqual({
      environmentName: "NEMOCLAW_REASONING",
      kind: "legacy-image-environment",
    });
  });
});
