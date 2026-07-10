// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  applyHermesLightSkinConfig,
  buildSandboxConnectEnv,
  hermesConfigUsesManagedLightSkin,
  NEMOCLAW_HERMES_LIGHT_SKIN_NAME,
  NEMOCLAW_HERMES_LIGHT_SKIN_YAML,
  shouldApplyHermesLightSkin,
  shouldInspectHermesLightSkinConfig,
} from "./connect-env";

describe("sandbox connect environment helpers", () => {
  it("keeps the connect environment unchanged; Hermes light skin is prepared in sandbox config (#6380)", () => {
    expect(
      buildSandboxConnectEnv(
        { name: "hermes" },
        { COLORFGBG: "0;15", TERM_PROGRAM: "Apple_Terminal" },
      ),
    ).toEqual(
      expect.objectContaining({
        COLORFGBG: "0;15",
        TERM_PROGRAM: "Apple_Terminal",
      }),
    );
  });

  it("inspects Hermes config only for light terminals without user theme overrides (#6380)", () => {
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
    ).toBe(false);
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
      shouldInspectHermesLightSkinConfig({ name: "hermes" }, { TERM_PROGRAM: "Apple_Terminal" }),
    ).toBe(false);
    expect(
      shouldInspectHermesLightSkinConfig(
        { name: "hermes" },
        { COLORFGBG: "not-a-color", TERM_PROGRAM: "Apple_Terminal" },
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

  it("preserves user-owned Hermes display skins (#6380)", () => {
    const userConfig = { display: { skin: "solarized-light" } };
    expect(shouldApplyHermesLightSkin({ name: "hermes" }, { COLORFGBG: "0;15" }, userConfig)).toBe(
      false,
    );
    expect(applyHermesLightSkinConfig(userConfig)).toBe(false);
    expect(userConfig.display.skin).toBe("solarized-light");
  });
});
