// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ConfigObject, ConfigValue } from "../../security/credential-filter";

export const NEMOCLAW_HERMES_LIGHT_SKIN_NAME = "nemoclaw-light";

function isConfigRecord(value: ConfigValue): value is ConfigObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hermesConfigUsesManagedLightSkin(config: ConfigObject): boolean {
  const display = config.display;
  return isConfigRecord(display) && display.skin === NEMOCLAW_HERMES_LIGHT_SKIN_NAME;
}

export function removeHermesLightSkinConfig(config: ConfigObject): boolean {
  const display = config.display;
  if (!isConfigRecord(display) || display.skin !== NEMOCLAW_HERMES_LIGHT_SKIN_NAME) {
    return false;
  }
  delete display.skin;
  if (Object.keys(display).length === 0) delete config.display;
  return true;
}
