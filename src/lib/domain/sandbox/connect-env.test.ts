// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  hermesConfigUsesManagedLightSkin,
  NEMOCLAW_HERMES_LIGHT_SKIN_NAME,
  removeHermesLightSkinConfig,
} from "./connect-env";

describe("sandbox connect environment helpers", () => {
  it("removes only the retired NemoClaw Hermes light skin (#6380)", () => {
    const config = {
      display: { skin: NEMOCLAW_HERMES_LIGHT_SKIN_NAME, width: 100 },
      model: "test",
    };

    expect(hermesConfigUsesManagedLightSkin(config)).toBe(true);
    expect(removeHermesLightSkinConfig(config)).toBe(true);
    expect(config).toEqual({ display: { width: 100 }, model: "test" });
  });

  it("removes an empty display object with the retired skin (#6380)", () => {
    const config: { display?: { skin?: string } } = {
      display: { skin: NEMOCLAW_HERMES_LIGHT_SKIN_NAME },
    };

    expect(removeHermesLightSkinConfig(config)).toBe(true);
    expect(config).toEqual({});
  });

  it.each([{}, { display: "invalid" }, { display: { skin: "solarized-light" } }])(
    "leaves operator-owned display state unchanged %# (#6380)",
    (config) => {
      const before = structuredClone(config);

      expect(hermesConfigUsesManagedLightSkin(config)).toBe(false);
      expect(removeHermesLightSkinConfig(config)).toBe(false);
      expect(config).toEqual(before);
    },
  );
});
