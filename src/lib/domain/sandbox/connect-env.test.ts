// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  applyHermesLightSkinConfig,
  buildHermesLightSkinConfig,
  buildSandboxConnectEnv,
  hermesConfigUsesManagedLightSkin,
  NEMOCLAW_HERMES_LIGHT_SKIN_NAME,
  removeHermesLightSkinConfig,
  shouldApplyHermesLightSkin,
  shouldPrepareHermesLightSkin,
  shouldRemoveHermesLightSkin,
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

  it("plans the NemoClaw Hermes light skin only for light terminals without user theme or skin (#6380)", () => {
    expect(
      shouldPrepareHermesLightSkin(
        { name: "hermes" },
        { COLORFGBG: "0;15", TERM_PROGRAM: "Apple_Terminal" },
        "model: test\n",
      ),
    ).toBe(true);
  });

  it("does not plan the NemoClaw Hermes light skin when the terminal is dark (#6380)", () => {
    expect(
      shouldPrepareHermesLightSkin(
        { name: "hermes" },
        { COLORFGBG: "0;0", TERM_PROGRAM: "Apple_Terminal" },
        "model: test\n",
      ),
    ).toBe(false);
  });

  it("does not plan the NemoClaw Hermes light skin when the user set Hermes theme env (#6380)", () => {
    for (const env of [{ HERMES_TUI_LIGHT: "0" }, { HERMES_TUI_THEME: "dark" }]) {
      expect(
        shouldPrepareHermesLightSkin({ name: "hermes" }, { COLORFGBG: "0;15", ...env }, ""),
      ).toBe(false);
    }
  });

  it("does not plan the NemoClaw Hermes light skin when config already has display.skin (#6380)", () => {
    expect(
      shouldPrepareHermesLightSkin(
        { name: "hermes" },
        { COLORFGBG: "0;15" },
        "display:\n  skin: solarized-light\n",
      ),
    ).toBe(false);
  });

  it("does not plan the NemoClaw Hermes light skin for non-Hermes agents (#6380)", () => {
    expect(
      shouldPrepareHermesLightSkin({ name: "openclaw" }, { COLORFGBG: "0;15" }, "model: test\n"),
    ).toBe(false);
  });

  it("does not infer light mode from Apple Terminal without usable COLORFGBG (#6380)", () => {
    expect(
      shouldPrepareHermesLightSkin({ name: "hermes" }, { TERM_PROGRAM: "Apple_Terminal" }, ""),
    ).toBe(false);
    expect(
      shouldPrepareHermesLightSkin(
        { name: "hermes" },
        { COLORFGBG: "not-a-color", TERM_PROGRAM: "Apple_Terminal" },
        "",
      ),
    ).toBe(false);
  });

  it("adds display.skin to Hermes config without changing existing fields (#6380)", () => {
    expect(buildHermesLightSkinConfig("model: test\n")).toBe(
      `model: test\ndisplay:\n  skin: ${NEMOCLAW_HERMES_LIGHT_SKIN_NAME}\n`,
    );
  });

  it("does not rewrite Hermes config when display.skin is already explicit (#6380)", () => {
    expect(
      buildHermesLightSkinConfig("display:\n  skin: solarized-light\nmodel: test\n"),
    ).toBeNull();
  });

  it("applies and later removes only the NemoClaw-managed Hermes light skin (#6380)", () => {
    const config = { model: "test" };

    expect(shouldApplyHermesLightSkin({ name: "hermes" }, { COLORFGBG: "0;15" }, config)).toBe(
      true,
    );
    expect(applyHermesLightSkinConfig(config)).toBe(true);
    expect(hermesConfigUsesManagedLightSkin(config)).toBe(true);

    expect(shouldRemoveHermesLightSkin({ name: "hermes" }, { COLORFGBG: "0;0" }, config)).toBe(
      true,
    );
    expect(removeHermesLightSkinConfig(config)).toBe(true);
    expect(config).toEqual({ model: "test" });
  });

  it("preserves user-owned Hermes display skins while cleaning managed skin state (#6380)", () => {
    const userConfig = { display: { skin: "solarized-light" } };
    expect(shouldApplyHermesLightSkin({ name: "hermes" }, { COLORFGBG: "0;15" }, userConfig)).toBe(
      false,
    );
    expect(applyHermesLightSkinConfig(userConfig)).toBe(false);
    expect(removeHermesLightSkinConfig(userConfig)).toBe(false);
    expect(userConfig.display.skin).toBe("solarized-light");
  });
});
