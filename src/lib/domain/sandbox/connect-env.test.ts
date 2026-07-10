// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  applyHermesLightSkinConfig,
  hermesConfigUsesManagedLightSkin,
  NEMOCLAW_HERMES_LIGHT_SKIN_NAME,
  NEMOCLAW_HERMES_LIGHT_SKIN_REVIEWED_HERMES_VERSIONS,
  NEMOCLAW_HERMES_LIGHT_SKIN_YAML,
  removeHermesLightSkinConfig,
  shouldApplyHermesLightSkin,
  shouldInspectHermesLightSkinConfig,
  shouldRemoveHermesLightSkin,
} from "./connect-env";

describe("sandbox connect environment helpers", () => {
  it("tracks Hermes versions reviewed for the managed light skin compatibility shim (#6380)", () => {
    expect(NEMOCLAW_HERMES_LIGHT_SKIN_REVIEWED_HERMES_VERSIONS).toEqual([
      "v2026.6.19",
      "v2026.7.1",
    ]);
  });

  it("inspects Hermes config only when NemoClaw owns the theme decision (#6380)", () => {
    expect(
      shouldInspectHermesLightSkinConfig(
        { name: "hermes" },
        { COLORFGBG: "0;15", TERM_PROGRAM: "Apple_Terminal" },
      ),
    ).toBe(true);
    expect(
      shouldInspectHermesLightSkinConfig(
        { name: "hermes" },
        { COLORFGBG: "0;0", TERM_PROGRAM: "Apple_Terminal" },
      ),
    ).toBe(true);
    for (const env of [{ HERMES_TUI_LIGHT: "0" }, { HERMES_TUI_THEME: "dark" }]) {
      expect(
        shouldInspectHermesLightSkinConfig({ name: "hermes" }, { COLORFGBG: "0;15", ...env }),
      ).toBe(false);
    }
    expect(shouldInspectHermesLightSkinConfig({ name: "openclaw" }, { COLORFGBG: "0;15" })).toBe(
      false,
    );
  });

  it("does not infer light mode from Apple Terminal without usable COLORFGBG (#6380)", () => {
    expect(
      shouldApplyHermesLightSkin(
        { name: "hermes" },
        { TERM_PROGRAM: "Apple_Terminal" },
        { model: "test" },
      ),
    ).toBe(false);
    expect(
      shouldApplyHermesLightSkin(
        { name: "hermes" },
        { COLORFGBG: "not-a-color", TERM_PROGRAM: "Apple_Terminal" },
        { model: "test" },
      ),
    ).toBe(false);
  });

  it("pins readable body and startup list colors in the managed Hermes light skin (#6380)", () => {
    const skin = YAML.parse(NEMOCLAW_HERMES_LIGHT_SKIN_YAML) as {
      colors: Record<string, string>;
    };
    expect(skin.colors).toMatchObject({
      response_body: "#7A5A0F",
      response_text: "#7A5A0F",
      skill_list_text: "#7A5A0F",
      tool_list_text: "#7A5A0F",
    });
  });

  it("applies only the NemoClaw-managed Hermes light skin (#6380)", () => {
    const config = { model: "test" };

    expect(shouldApplyHermesLightSkin({ name: "hermes" }, { COLORFGBG: "0;15" }, config)).toBe(
      true,
    );
    expect(applyHermesLightSkinConfig(config)).toBe(true);
    expect(hermesConfigUsesManagedLightSkin(config)).toBe(true);
  });

  it("removes only the NemoClaw-managed Hermes light skin from config (#6380)", () => {
    const config = {
      display: { skin: NEMOCLAW_HERMES_LIGHT_SKIN_NAME, width: 100 },
      model: "test",
    };

    expect(shouldRemoveHermesLightSkin({ name: "hermes" }, { COLORFGBG: "0;0" }, config)).toBe(
      true,
    );
    expect(removeHermesLightSkinConfig(config)).toBe(true);
    expect(config).toEqual({ display: { width: 100 }, model: "test" });
  });

  it("removes the empty display section when it only contains the managed Hermes skin (#6380)", () => {
    const config = {
      display: { skin: NEMOCLAW_HERMES_LIGHT_SKIN_NAME },
      model: "test",
    };

    expect(removeHermesLightSkinConfig(config)).toBe(true);
    expect(config).toEqual({ model: "test" });
  });

  it("preserves user-owned Hermes display skins (#6380)", () => {
    const userConfig = { display: { skin: "solarized-light" } };
    expect(shouldApplyHermesLightSkin({ name: "hermes" }, { COLORFGBG: "0;15" }, userConfig)).toBe(
      false,
    );
    expect(applyHermesLightSkinConfig(userConfig)).toBe(false);
    expect(userConfig.display.skin).toBe("solarized-light");
  });

  it("preserves explicit non-string Hermes display skin values (#6380)", () => {
    const config = { display: { skin: null }, model: "test" };

    expect(shouldApplyHermesLightSkin({ name: "hermes" }, { COLORFGBG: "0;15" }, config)).toBe(
      false,
    );
    expect(applyHermesLightSkinConfig(config)).toBe(false);
    expect(config.display.skin).toBeNull();
  });
});
