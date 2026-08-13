// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingInputReference } from "../../manifest";
import { normalizeFullInputs, normalizePersistedInputs } from "../../persistence";
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

function policyInputs(mode: string, ids = ""): SandboxMessagingInputReference[] {
  const allowlist: SandboxMessagingInputReference[] = ids
    ? [
        {
          channelId: "whatsapp",
          inputId: "allowedIds",
          kind: "config",
          required: false,
          statePath: "allowedIds.whatsapp",
          value: ids,
        },
      ]
    : [];
  return [...modeInputs(mode), ...allowlist];
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

  it.each([
    [
      "a full persisted plan",
      () =>
        normalizeFullInputs("whatsapp", [
          {
            inputId: "mode",
            kind: "config",
            required: false,
            statePath: "whatsappConfig.mode",
            value: "broadcast",
          },
        ]),
    ],
    [
      "a compact persisted plan",
      () =>
        normalizePersistedInputs(
          {
            channelId: "whatsapp",
            // The compact path reads only inputId and value; the manifest spec
            // supplies the rest.
            inputs: [
              {
                channelId: "whatsapp",
                inputId: "mode",
                kind: "config",
                required: false,
                value: "broadcast",
              },
            ],
          },
          whatsappManifest,
        ),
    ],
  ])("refuses an unsupported mode carried by %s (#8312)", (_case, buildInputs) => {
    // A rebuild renders from the persisted plan, and neither persistence path
    // re-applies the input's validValues, so the registry can hand the resolver
    // a mode the bundled bridge cannot serve.
    expect(
      resolveWhatsappTemplateReference("whatsappConfig.mode", { inputs: buildInputs() })?.value,
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
    // The operator picks the mode, so the prompt must exist: the config-prompt
    // hook resolves a field only for an input that declares one, and a blank
    // answer falls back to the declared default.
    expect(mode).toHaveProperty("prompt.label", "WhatsApp reply mode");
    expect(mode).toHaveProperty("validValues", ["self-chat", "bot"]);
  });

  it("asks only Hermes for the reply mode (#8312)", () => {
    // The OpenClaw fragment carries no sender policy and OpenClaw never reads
    // the Hermes env, so an OpenClaw operator would answer a question nothing
    // consumes.
    const configPrompt = whatsappManifest.hooks.find(
      (hook) => hook.handler === "common.configPrompt",
    );

    expect(configPrompt).toMatchObject({ phase: "enroll", agents: ["hermes"] });
    expect(configPrompt?.outputs).toEqual([{ id: "mode", kind: "config" }]);
  });

  it("renders the DM policy beside the mode it depends on (#8312)", () => {
    const hermesEnv = whatsappManifest.render.find((entry) => entry.id === "whatsapp-hermes-env");

    expect(hermesEnv).toHaveProperty("lines", [
      "WHATSAPP_ENABLED=true",
      "WHATSAPP_MODE={{whatsappConfig.mode}}",
      "WHATSAPP_DM_POLICY={{whatsappConfig.dmPolicy}}",
      "WHATSAPP_ALLOWED_USERS={{allowedIds.whatsapp.csv}}",
    ]);
  });
});

describe("WhatsApp DM policy", () => {
  it("leaves the policy unset in self-chat mode (#8312)", () => {
    // self-chat drops every message that is not the paired account's own before
    // the bridge reads a policy, so rendering one would state a rule nothing
    // applies.
    expect(
      resolveWhatsappTemplateReference("whatsappConfig.dmPolicy", {
        inputs: policyInputs("self-chat", "15551234567"),
      })?.value,
    ).toBeUndefined();
  });

  it("pairs unknown senders when bot mode carries no allowlist (#8312)", () => {
    // Dropping the key here would leave the bridge on its own `open` default,
    // which enforces the empty allowlist and rejects every sender.
    expect(
      resolveWhatsappTemplateReference("whatsappConfig.dmPolicy", {
        inputs: policyInputs("bot"),
      })?.value,
    ).toBe("pairing");
  });

  it("enforces the allowlist when bot mode names senders (#8312)", () => {
    expect(
      resolveWhatsappTemplateReference("whatsappConfig.dmPolicy", {
        inputs: policyInputs("bot", "15551234567,15557654321"),
      })?.value,
    ).toBe("allowlist");
  });

  it("leaves the policy unset when the stored mode is unusable (#8312)", () => {
    // The mode fallback decides the policy, so a registry entry the bridge
    // cannot serve must not open the gateway to unknown senders.
    expect(
      resolveWhatsappTemplateReference("whatsappConfig.dmPolicy", {
        inputs: policyInputs("broadcast", "15551234567"),
      })?.value,
    ).toBeUndefined();
  });
});
