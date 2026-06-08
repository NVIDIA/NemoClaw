// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

type JsonObject = Record<string, unknown>;

type ManifestHookRenderResult = {
  readonly appliedHooks: readonly string[];
  readonly appliedTargets: readonly string[];
  readonly unresolvedTemplateRefs: readonly string[];
};

type MessagingRenderEntry = {
  readonly channelId: string;
  readonly agent: string;
  readonly target: string;
  readonly kind: "json-fragment" | "env-lines";
  readonly renderId?: string;
  readonly hookId?: string;
  readonly handler?: string;
  readonly path?: string;
  readonly value?: unknown;
  readonly lines?: readonly string[];
  readonly templateRefs?: readonly string[];
};

type HermesManifestHookPlan = {
  readonly schemaVersion: 1;
  readonly agent: "hermes";
  readonly channels: readonly {
    readonly channelId: string;
    readonly active?: boolean;
    readonly disabled?: boolean;
  }[];
  readonly agentRender: readonly MessagingRenderEntry[];
};

const HERMES_CONFIG_TARGET = "~/.hermes/config.yaml";
const HERMES_ENV_TARGET = "~/.hermes/.env";

export function readHermesManifestHookPlan(
  env: NodeJS.ProcessEnv,
): HermesManifestHookPlan | null {
  const encoded = env.NEMOCLAW_MESSAGING_PLAN_B64;
  if (!encoded || encoded.trim() === "") return null;

  const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")) as unknown;
  if (
    !isObject(parsed) ||
    parsed.schemaVersion !== 1 ||
    parsed.agent !== "hermes" ||
    !Array.isArray(parsed.channels) ||
    !Array.isArray(parsed.agentRender)
  ) {
    throw new Error("NEMOCLAW_MESSAGING_PLAN_B64 must contain a hermes messaging plan");
  }

  return parsed as HermesManifestHookPlan;
}

export function applyHermesManifestHookRender(
  config: JsonObject,
  envLines: string[],
  plan: HermesManifestHookPlan | null,
): ManifestHookRenderResult {
  if (!plan) {
    return { appliedHooks: [], appliedTargets: [], unresolvedTemplateRefs: [] };
  }

  const activeChannels = new Set(
    plan.channels
      .filter((channel) => channel.active === true && channel.disabled !== true)
      .map((channel) => channel.channelId),
  );
  const appliedHooks: string[] = [];
  const appliedTargets: string[] = [];
  const unresolvedTemplateRefs: string[] = [];

  for (const render of plan.agentRender) {
    if (render.agent !== "hermes" || !activeChannels.has(render.channelId)) continue;
    unresolvedTemplateRefs.push(...(render.templateRefs ?? []));
    if (render.kind === "json-fragment") {
      applyJsonRender(config, render);
      appliedTargets.push(render.target);
      if (render.hookId) appliedHooks.push(`${render.channelId}:${render.hookId}`);
      continue;
    }
    applyEnvRender(envLines, render);
    appliedTargets.push(render.target);
    if (render.hookId) appliedHooks.push(`${render.channelId}:${render.hookId}`);
  }

  return {
    appliedHooks: uniqueStrings(appliedHooks),
    appliedTargets: uniqueStrings(appliedTargets),
    unresolvedTemplateRefs: uniqueStrings(unresolvedTemplateRefs),
  };
}

function applyJsonRender(config: JsonObject, render: MessagingRenderEntry): void {
  if (render.target !== HERMES_CONFIG_TARGET) {
    throw new Error(`Hermes manifest hook render target is not supported: ${render.target}`);
  }
  if (typeof render.path !== "string") {
    throw new Error(
      `Hermes manifest hook render '${render.renderId ?? render.channelId}' is missing a path.`,
    );
  }
  setJsonPath(config, render.path, render.value);
}

function applyEnvRender(envLines: string[], render: MessagingRenderEntry): void {
  if (render.target !== HERMES_ENV_TARGET) {
    throw new Error(`Hermes manifest hook render target is not supported: ${render.target}`);
  }
  if (!Array.isArray(render.lines)) {
    throw new Error(
      `Hermes manifest hook render '${render.renderId ?? render.channelId}' is missing env lines.`,
    );
  }
  mergeEnvLines(envLines, render.lines);
}

function setJsonPath(root: JsonObject, path: string, value: unknown): void {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) throw new Error("Hermes manifest hook render path must not be empty.");
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    assertSafeObjectKey(segment);
    if (!isObject(cursor[segment])) cursor[segment] = {};
    cursor = cursor[segment] as JsonObject;
  }
  const finalSegment = segments[segments.length - 1] as string;
  assertSafeObjectKey(finalSegment);
  if (isObject(cursor[finalSegment]) && isObject(value)) {
    mergeObjects(cursor[finalSegment] as JsonObject, value as JsonObject);
    return;
  }
  cursor[finalSegment] = value;
}

function mergeObjects(target: JsonObject, patch: JsonObject): void {
  for (const [key, value] of Object.entries(patch)) {
    assertSafeObjectKey(key);
    const existing = target[key];
    if (isObject(existing) && isObject(value)) {
      mergeObjects(existing as JsonObject, value as JsonObject);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      target[key] = [...new Set([...existing, ...value])];
    } else {
      target[key] = value;
    }
  }
}

function mergeEnvLines(existingLines: string[], desiredLines: readonly string[]): void {
  const desired = new Map<string, string>();
  const rawDesiredLines: string[] = [];
  for (const line of desiredLines) {
    const key = readEnvLineKey(line);
    if (key) {
      desired.set(key, line);
    } else {
      rawDesiredLines.push(line);
    }
  }

  const written = new Set<string>();
  for (const [index, line] of existingLines.entries()) {
    const key = readEnvLineKey(line);
    if (!key || !desired.has(key)) continue;
    existingLines[index] = desired.get(key) as string;
    written.add(key);
  }

  for (const [key, line] of desired) {
    if (!written.has(key)) existingLines.push(line);
  }
  existingLines.push(...rawDesiredLines);
}

function readEnvLineKey(line: string): string | null {
  const index = line.indexOf("=");
  if (index <= 0) return null;
  const key = line.slice(0, index).trim();
  return key.length > 0 ? key : null;
}

function assertSafeObjectKey(key: string): void {
  if (key === "__proto__" || key === "prototype" || key === "constructor") {
    throw new Error(`Hermes manifest hook render rejected unsafe object key '${key}'.`);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
