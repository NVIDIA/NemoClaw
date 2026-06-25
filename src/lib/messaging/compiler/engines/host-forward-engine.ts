// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelManifest,
  SandboxMessagingHostForwardPlan,
  SandboxMessagingInputReference,
} from "../../manifest";
import {
  isTruthyRenderTemplate,
  type RenderTemplateReferenceResolver,
  resolveRenderTemplatesInValue,
} from "./template";

export function planHostForward(
  manifest: ChannelManifest,
  inputs: readonly SandboxMessagingInputReference[],
  active: boolean,
  referenceResolver?: RenderTemplateReferenceResolver,
): SandboxMessagingHostForwardPlan | undefined {
  if (!active || !manifest.hostForward) return undefined;

  const context = { inputs, env: process.env, referenceResolver };
  if (!isTruthyRenderTemplate(manifest.hostForward.when, context)) return undefined;

  const portValue = resolveRenderTemplatesInValue(manifest.hostForward.port, context);
  const port = normalizeForwardPort(manifest.id, portValue);
  return {
    channelId: manifest.id,
    port,
    label: manifest.hostForward.label,
  };
}

function normalizeForwardPort(channelId: string, value: unknown): number {
  const port = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Channel manifest '${channelId}' declares invalid host forward port '${String(value)}'.`,
    );
  }
  return port;
}
