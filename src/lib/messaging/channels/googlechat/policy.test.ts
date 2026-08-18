// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { loadMessagingChannelPolicyPreset } from "../policy";

type PolicyRule = { readonly allow?: { readonly method?: string; readonly path?: string } };
type PolicyEndpoint = { readonly host?: string; readonly rules?: readonly PolicyRule[] };

const PUBSUB_PULL = "/v1/projects/*/subscriptions/*:pull";
const PUBSUB_ACKNOWLEDGE = "/v1/projects/*/subscriptions/*:acknowledge";

function endpointsFor(agent: string): readonly PolicyEndpoint[] {
  const preset = loadMessagingChannelPolicyPreset("googlechat", { agent });
  expect(preset, `no googlechat policy preset for ${agent}`).toBeTruthy();
  const parsed = YAML.parse(preset ?? "") as {
    network_policies?: Record<string, { endpoints?: readonly PolicyEndpoint[] }>;
  };
  return Object.values(parsed.network_policies ?? {}).flatMap((policy) => policy.endpoints ?? []);
}

function rulesForHost(agent: string, host: string): readonly PolicyRule[] {
  return endpointsFor(agent).find((endpoint) => endpoint.host === host)?.rules ?? [];
}

describe("Google Chat Hermes egress policy", () => {
  // The adapter test proves the override only issues :pull and :acknowledge. This
  // pins the other half: the preset must not hand the sandbox anything wider,
  // because a `/v1/**` allow would also cover publish and subscription admin.
  it("allows exactly the two Pub/Sub operations the REST pull issues", () => {
    expect(rulesForHost("hermes", "pubsub.googleapis.com")).toEqual([
      { allow: { method: "POST", path: PUBSUB_PULL } },
      { allow: { method: "POST", path: PUBSUB_ACKNOWLEDGE } },
    ]);
  });

  it("keeps Chat writes inside the spaces tree", () => {
    expect(rulesForHost("hermes", "chat.googleapis.com")).toEqual([
      { allow: { method: "GET", path: "/v1/**" } },
      { allow: { method: "POST", path: "/v1/spaces/**" } },
      { allow: { method: "PATCH", path: "/v1/spaces/**" } },
      { allow: { method: "DELETE", path: "/v1/spaces/**" } },
    ]);
  });

  it("reaches no host beyond Pub/Sub and Chat", () => {
    expect(new Set(endpointsFor("hermes").map((endpoint) => endpoint.host))).toEqual(
      new Set(["pubsub.googleapis.com", "chat.googleapis.com"]),
    );
  });

  it("grants OpenClaw no Pub/Sub egress, since it runs on an inbound webhook", () => {
    expect(rulesForHost("openclaw", "pubsub.googleapis.com")).toEqual([]);
  });
});
