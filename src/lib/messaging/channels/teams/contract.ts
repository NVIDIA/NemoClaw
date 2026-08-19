// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Schema-owned identity for the stock Microsoft Teams OpenClaw webhook render. */
export const TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT = {
  channelId: "teams",
  renderId: "teams-openclaw-channel",
  hookId: "teams-openclaw-channel",
  handlerId: "common.staticOutputs",
  kind: "json-fragment",
  agent: "openclaw",
  target: "openclaw.json",
  configPath: "channels.msteams",
  webhookPath: "/api/messages",
} as const;

export interface TeamsManagedStartupFieldAuthorization {
  readonly path: readonly string[];
  readonly value: Record<string, unknown>;
}

export function authorizeTeamsOpenClawWebhookField(
  entry: unknown,
): readonly TeamsManagedStartupFieldAuthorization[] {
  if (!isPlainDataObject(entry)) return [];
  const contract = TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT;
  if (
    ownDataPropertyValue(entry, "channelId") !== contract.channelId ||
    ownDataPropertyValue(entry, "renderId") !== contract.renderId ||
    ownDataPropertyValue(entry, "hookId") !== contract.hookId ||
    ownDataPropertyValue(entry, "handler") !== contract.handlerId ||
    ownDataPropertyValue(entry, "kind") !== contract.kind ||
    ownDataPropertyValue(entry, "agent") !== contract.agent ||
    ownDataPropertyValue(entry, "target") !== contract.target ||
    ownDataPropertyValue(entry, "path") !== contract.configPath
  ) {
    return [];
  }

  const value = ownDataPropertyValue(entry, "value");
  if (!isPlainDataObject(value)) return [];
  const webhook = ownDataPropertyValue(value, "webhook");
  if (
    !isPlainDataObject(webhook) ||
    !hasExactlyOwnDataProperties(webhook, ["path", "port"]) ||
    !isTcpPort(ownDataPropertyValue(webhook, "port")) ||
    ownDataPropertyValue(webhook, "path") !== contract.webhookPath
  ) {
    return [];
  }

  return [{ path: ["value", "webhook"], value: webhook }];
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataPropertyValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function hasExactlyOwnDataProperties(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.getOwnPropertyNames(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isTcpPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}
