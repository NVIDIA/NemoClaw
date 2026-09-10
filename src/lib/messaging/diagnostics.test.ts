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
      "teams",
      "googlechat",
    ]);
    expect(specs.find((spec) => spec.channelId === "telegram")).toMatchObject({
      preferredDefault: false,
      deepProbe: "log-tail",
    });
    expect(specs.find((spec) => spec.channelId === "wechat")).toMatchObject({});
    expect(specs.find((spec) => spec.channelId === "whatsapp")).toMatchObject({
      preferredDefault: true,
      deepProbe: "in-sandbox-qr",
      doctorWhenNoHealthSignals: expect.objectContaining({
        hint: "run `{cli} {sandbox} channels status --channel {channel}` to probe inbound delivery",
      }),
    });
    expect(specs.find((spec) => spec.channelId === "teams")).toMatchObject({
      preferredDefault: false,
    });
  });
});
