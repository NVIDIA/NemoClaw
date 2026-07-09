// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

export const NEMOCLAW_HERMES_LIGHT_SKIN_NAME = "nemoclaw-light";

export const NEMOCLAW_HERMES_LIGHT_SKIN_YAML = `name: ${NEMOCLAW_HERMES_LIGHT_SKIN_NAME}
description: NemoClaw-managed Hermes light terminal compatibility skin
colors:
  banner_border: "#CD7F32"
  banner_title: "#FFD700"
  banner_accent: "#FFBF00"
  banner_dim: "#B8860B"
  banner_text: "#7A5A0F"
  prompt: "#7A5A0F"
  response_border: "#FFD700"
`;

function hasEnvValue(value: string | undefined): boolean {
  return String(value ?? "").trim().length > 0;
}

export function hostTerminalLooksLight(env: NodeJS.ProcessEnv): boolean {
  const colorfgbg = String(env.COLORFGBG ?? "").trim();
  if (!colorfgbg) return false;

  const lastField = colorfgbg.split(";").at(-1) ?? "";
  const bg = Number(lastField);
  if (!Number.isInteger(bg) || bg < 0 || bg > 15) return false;
  return bg === 7 || bg === 15;
}

export function hermesConfigHasDisplaySkin(configText: string): boolean | null {
  try {
    const doc = YAML.parseDocument(configText.trim() ? configText : "{}");
    if (doc.errors.length > 0) return null;
    const root = doc.toJSON();
    if (root !== null && (typeof root !== "object" || Array.isArray(root))) return null;
    return doc.hasIn(["display", "skin"]);
  } catch {
    return null;
  }
}

export function buildHermesLightSkinConfig(configText: string): string | null {
  try {
    const doc = YAML.parseDocument(configText.trim() ? configText : "{}");
    if (doc.errors.length > 0) return null;

    const root = doc.toJSON();
    if (root !== null && (typeof root !== "object" || Array.isArray(root))) return null;
    if (doc.hasIn(["display", "skin"])) return null;

    const display = doc.get("display", true);
    if (display !== undefined && display !== null && !YAML.isMap(display)) return null;
    if (!YAML.isMap(display)) doc.set("display", doc.createNode({}));

    doc.setIn(["display", "skin"], NEMOCLAW_HERMES_LIGHT_SKIN_NAME);
    return String(doc).trimEnd() + "\n";
  } catch {
    return null;
  }
}

export function shouldPrepareHermesLightSkin(
  agent: { name?: string } | null | undefined,
  env: NodeJS.ProcessEnv,
  hermesConfigText: string,
): boolean {
  return (
    agent?.name === "hermes" &&
    hostTerminalLooksLight(env) &&
    !hasEnvValue(env.HERMES_TUI_LIGHT) &&
    !hasEnvValue(env.HERMES_TUI_THEME) &&
    hermesConfigHasDisplaySkin(hermesConfigText) === false
  );
}

export function buildSandboxConnectEnv(
  _agent: { name?: string } | null | undefined,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...env };
}
