// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ConfigObject, ConfigValue } from "../../security/credential-filter";

export const NEMOCLAW_HERMES_LIGHT_SKIN_NAME = "nemoclaw-light";
export const NEMOCLAW_HERMES_LIGHT_SKIN_REVIEWED_HERMES_VERSIONS = [
  "v2026.6.19",
  "v2026.7.1",
] as const;

// Compatibility boundary: remove this NemoClaw-managed light skin once the
// pinned Hermes version in agents/hermes/Dockerfile.base includes upstream
// readable light-terminal defaults for assistant response and startup list text.
// The paired unit test intentionally fails on a Hermes version bump so this
// compatibility shim is re-reviewed instead of silently aging forward.
export const NEMOCLAW_HERMES_LIGHT_SKIN_YAML = `name: ${NEMOCLAW_HERMES_LIGHT_SKIN_NAME}
description: NemoClaw-managed Hermes light terminal compatibility skin
colors:
  banner_border: "#CD7F32"
  banner_title: "#FFD700"
  banner_accent: "#FFBF00"
  banner_dim: "#B8860B"
  banner_text: "#7A5A0F"
  prompt: "#7A5A0F"
  response_text: "#7A5A0F"
  response_body: "#7A5A0F"
  response_border: "#FFD700"
  tool_list_text: "#7A5A0F"
  skill_list_text: "#7A5A0F"
`;

function hasEnvValue(value: string | undefined): boolean {
  return String(value ?? "").trim().length > 0;
}

function isConfigRecord(value: ConfigValue): value is ConfigObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hermesConfigDisplaySkin(config: ConfigObject): string | null {
  const display = config.display;
  if (!isConfigRecord(display)) return null;
  return typeof display.skin === "string" ? display.skin : null;
}

export function hermesConfigUsesManagedLightSkin(config: ConfigObject): boolean {
  return hermesConfigDisplaySkin(config) === NEMOCLAW_HERMES_LIGHT_SKIN_NAME;
}

function canApplyHermesLightSkinConfig(config: ConfigObject): boolean {
  const display = config.display;
  if (display === undefined) return true;
  if (!isConfigRecord(display)) return false;
  return display.skin === undefined || display.skin === NEMOCLAW_HERMES_LIGHT_SKIN_NAME;
}

export function applyHermesLightSkinConfig(config: ConfigObject): boolean {
  const display = config.display;
  if (isConfigRecord(display)) {
    if (display.skin !== undefined && display.skin !== NEMOCLAW_HERMES_LIGHT_SKIN_NAME) {
      return false;
    }
    if (display.skin === NEMOCLAW_HERMES_LIGHT_SKIN_NAME) return false;
    display.skin = NEMOCLAW_HERMES_LIGHT_SKIN_NAME;
    return true;
  }
  if (display !== undefined) return false;
  config.display = { skin: NEMOCLAW_HERMES_LIGHT_SKIN_NAME };
  return true;
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

export function hostTerminalLooksLight(env: NodeJS.ProcessEnv): boolean {
  const colorfgbg = String(env.COLORFGBG ?? "").trim();
  if (!colorfgbg) return false;

  const lastField = colorfgbg.split(";").at(-1) ?? "";
  const bg = Number(lastField);
  if (!Number.isInteger(bg) || bg < 0 || bg > 15) return false;
  return bg === 7 || bg === 15;
}

export function shouldInspectHermesLightSkinConfig(
  agent: { name?: string } | null | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    agent?.name === "hermes" &&
    !hasEnvValue(env.HERMES_TUI_LIGHT) &&
    !hasEnvValue(env.HERMES_TUI_THEME)
  );
}

export function shouldApplyHermesLightSkin(
  agent: { name?: string } | null | undefined,
  env: NodeJS.ProcessEnv,
  config: ConfigObject,
): boolean {
  return (
    shouldInspectHermesLightSkinConfig(agent, env) &&
    hostTerminalLooksLight(env) &&
    canApplyHermesLightSkinConfig(config)
  );
}

export function shouldRemoveHermesLightSkin(
  agent: { name?: string } | null | undefined,
  env: NodeJS.ProcessEnv,
  config: ConfigObject,
): boolean {
  return (
    shouldInspectHermesLightSkinConfig(agent, env) &&
    !hostTerminalLooksLight(env) &&
    hermesConfigUsesManagedLightSkin(config)
  );
}
