// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingInputReference } from "../../manifest";
import { whatsappManifest } from "./manifest";
import { resolveWhatsappTemplateReference } from "./template-resolver";

function modeInputs(value: string | undefined): SandboxMessagingInputReference[] {
  const base = {
    channelId: "whatsapp",
    inputId: "mode",
    kind: "config",
    required: false,
    statePath: "whatsappConfig.mode",
  } as const;
  return [value === undefined ? base : { ...base, value }];
}

describe("WhatsApp template resolver", () => {
  it.each(["self-chat", "bot"] as const)("resolves the %s mode (#8312)", (mode) => {
    expect(
      resolveWhatsappTemplateReference("whatsappConfig.mode", { inputs: modeInputs(mode) })?.value,
    ).toBe(mode);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("renders the adapter default when the stored mode is %s (#8312)", (_case, stored) => {
    // The compiler drops a value outside validValues, so this is also the path
    // an unusable stored mode takes. Keep the line present rather than absent:
    // a sealed .env that states the mode is the only place an operator can read
    // it back.
    expect(
      resolveWhatsappTemplateReference("whatsappConfig.mode", { inputs: modeInputs(stored) })
        ?.value,
    ).toBe("self-chat");
  });

  it("declares a mode input whose default matches the resolver fallback (#8312)", () => {
    const mode = whatsappManifest.inputs.find((input) => input.id === "mode");

    expect(mode).toMatchObject({
      kind: "config",
      required: false,
      envKey: "WHATSAPP_MODE",
      statePath: "whatsappConfig.mode",
      defaultValue: "self-chat",
    });
    // Onboarding must not ask for the mode; selecting bot is post-onboarding
    // guidance through WHATSAPP_MODE, matching how allowedIds is supplied.
    expect(mode).not.toHaveProperty("prompt");
    expect(mode).toHaveProperty("validValues", ["self-chat", "bot"]);
  });
});
