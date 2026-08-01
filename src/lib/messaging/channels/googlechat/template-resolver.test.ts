// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingInputReference } from "../../manifest";
import { resolveGooglechatTemplateReference } from "./template-resolver";

function configInput(
  inputId: string,
  statePath: string,
  value: string,
): SandboxMessagingInputReference {
  return { channelId: "googlechat", inputId, kind: "config", required: false, statePath, value };
}

describe("Google Chat template resolver", () => {
  it("defaults audienceType when unset", () => {
    const inputs: SandboxMessagingInputReference[] = [];
    expect(
      resolveGooglechatTemplateReference("googlechatConfig.audienceType", { inputs })?.value,
    ).toBe("app-url");
  });

  it("passes through configured values; drops audience but seeds the appPrincipal sentinel when unset", () => {
    const set: SandboxMessagingInputReference[] = [
      configInput("audience", "googlechatConfig.audience", "https://x.example/googlechat"),
      configInput("appPrincipal", "googlechatConfig.appPrincipal", "103987852733692332624"),
      configInput("audienceType", "googlechatConfig.audienceType", "project-number"),
    ];
    expect(
      resolveGooglechatTemplateReference("googlechatConfig.audience", { inputs: set })?.value,
    ).toBe("https://x.example/googlechat");
    expect(
      resolveGooglechatTemplateReference("googlechatConfig.appPrincipal", { inputs: set })?.value,
    ).toBe("103987852733692332624");
    expect(
      resolveGooglechatTemplateReference("googlechatConfig.audienceType", { inputs: set })?.value,
    ).toBe("project-number");

    // Unset audience → undefined so the render engine drops the key entirely.
    // Unset appPrincipal → the all-zeros discovery sentinel (so the first DM
    // surfaces the real value) rather than dropping the key.
    const empty: SandboxMessagingInputReference[] = [];
    expect(
      resolveGooglechatTemplateReference("googlechatConfig.audience", { inputs: empty })?.value,
    ).toBeUndefined();
    expect(
      resolveGooglechatTemplateReference("googlechatConfig.appPrincipal", { inputs: empty })?.value,
    ).toBe("000000000000000000000");
  });

  it("normalizes the DM allowlist into nested dm.policy / dm.allowFrom", () => {
    const withIds: SandboxMessagingInputReference[] = [
      configInput("allowFrom", "allowedIds.googlechat", "users/111, user@example.com"),
    ];
    expect(
      resolveGooglechatTemplateReference("allowedIds.googlechat.dmPolicy", { inputs: withIds })
        ?.value,
    ).toBe("allowlist");
    expect(
      resolveGooglechatTemplateReference("allowedIds.googlechat.values", { inputs: withIds })
        ?.value,
    ).toEqual(["users/111", "user@example.com"]);

    // No allowlist → both undefined so the whole `dm` object drops out.
    const noIds: SandboxMessagingInputReference[] = [];
    expect(
      resolveGooglechatTemplateReference("allowedIds.googlechat.dmPolicy", { inputs: noIds })
        ?.value,
    ).toBeUndefined();
    expect(
      resolveGooglechatTemplateReference("allowedIds.googlechat.values", { inputs: noIds })?.value,
    ).toBeUndefined();
  });

  it("returns undefined for references it does not own", () => {
    expect(resolveGooglechatTemplateReference("teamsConfig.appId", { inputs: [] })).toBeUndefined();
  });
});
