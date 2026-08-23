// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  isCuaEnabled,
  requireCuaEnabled,
  requireCuaSandboxImageRef,
} from "./feature";

describe("NemoCUA feature gate", () => {
  it.each([undefined, "", "0", "01", " 1", "1 ", "true", "yes"])(
    "keeps NemoCUA disabled for NEMOCLAW_CUA_ENABLED=%s (#9649)",
    (value) => {
      expect(isCuaEnabled({ NEMOCLAW_CUA_ENABLED: value })).toBe(false);
      expect(() => requireCuaEnabled({ NEMOCLAW_CUA_ENABLED: value })).toThrow(
        "NemoCUA is disabled",
      );
    },
  );

  it("enables NemoCUA only for the exact value 1 (#9649)", () => {
    expect(isCuaEnabled({ NEMOCLAW_CUA_ENABLED: "1" })).toBe(true);
  });

  it("requires an explicit prepared sandbox image when NemoCUA is enabled (#9649)", () => {
    expect(() => requireCuaSandboxImageRef({ NEMOCLAW_CUA_ENABLED: "1" })).toThrow(
      "NEMOCLAW_CUA_SANDBOX_IMAGE_REF",
    );
    expect(
      requireCuaSandboxImageRef({
        NEMOCLAW_CUA_ENABLED: "1",
        NEMOCLAW_CUA_SANDBOX_IMAGE_REF: "nemocua-scenario:image-123",
      }),
    ).toBe("nemocua-scenario:image-123");
  });

  it.each(["image with-space", "image\nFROM attacker", "", " image "])(
    "rejects unsafe sandbox image input %j (#9649)",
    (imageRef) => {
      expect(() =>
        requireCuaSandboxImageRef({
          NEMOCLAW_CUA_ENABLED: "1",
          NEMOCLAW_CUA_SANDBOX_IMAGE_REF: imageRef,
        }),
      ).toThrow("must name the prepared NemoCUA sandbox image");
    },
  );
});
