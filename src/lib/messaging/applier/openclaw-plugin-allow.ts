// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type JsonObject = Record<string, unknown>;

type OpenClawPluginRender = {
  readonly path?: string;
  readonly value?: unknown;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enabledPluginId(render: OpenClawPluginRender): string | null {
  const segments = render.path?.split(".").filter(Boolean) ?? [];
  if (
    segments.length !== 3 ||
    segments[0] !== "plugins" ||
    segments[1] !== "entries" ||
    !isObject(render.value) ||
    render.value.enabled !== true
  ) {
    return null;
  }
  return segments[2] ?? null;
}

export function allowRenderedOpenClawPlugins(
  config: JsonObject,
  renderEntries: readonly OpenClawPluginRender[],
): void {
  const renderedPluginIds = renderEntries.flatMap((render) => {
    const pluginId = enabledPluginId(render);
    return pluginId ? [pluginId] : [];
  });
  if (renderedPluginIds.length === 0) return;

  const plugins = config.plugins;
  if (!isObject(plugins)) {
    throw new Error("OpenClaw messaging render requires a plugins object.");
  }
  const existingAllow = plugins.allow;
  if (existingAllow !== undefined && !Array.isArray(existingAllow)) {
    throw new Error("OpenClaw plugins.allow must be an array.");
  }
  const allowedPluginIds = (existingAllow ?? []).filter(
    (pluginId): pluginId is string => typeof pluginId === "string",
  );
  plugins.allow = [...new Set([...allowedPluginIds, ...renderedPluginIds])];
}
