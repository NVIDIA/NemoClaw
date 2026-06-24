// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { collectBuiltInMessagingChannelDiagnostics } from "./diagnostics";

describe("messaging channel diagnostics", () => {
  it("derives common channel diagnostic metadata directly from manifests", () => {
    const specs = collectBuiltInMessagingChannelDiagnostics();

    expect(specs.map((spec) => spec.channelId)).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
    ]);
    expect(specs.find((spec) => spec.channelId === "telegram")).toMatchObject({
      policyPresets: ["telegram"],
      preferredDefault: false,
    });
    expect(specs.find((spec) => spec.channelId === "wechat")).toMatchObject({
      policyPresets: ["wechat"],
    });
    expect(specs.find((spec) => spec.channelId === "whatsapp")).toMatchObject({
      policyPresets: ["whatsapp"],
      preferredDefault: true,
      deepProbe: "in-sandbox-qr",
      doctorWhenNoHealthSignals: expect.objectContaining({
        hint: "run `{cli} {sandbox} channels status --channel {channel}` to probe inbound delivery",
      }),
    });
  });
});
