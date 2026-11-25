// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { switchyardBindingFixture } from "../../test/helpers/hermes-switchyard";
import {
  createHermesSwitchyardRoutingIntent,
  serializeHermesSwitchyardRouting,
} from "./hermes-switchyard-routing";
import {
  encodeSwitchyardProviderBindings,
  HERMES_SWITCHYARD_BINDINGS_ENV,
  readSwitchyardProviderBindingsEnvironment,
  validateSwitchyardProviderBindings,
} from "./hermes-switchyard-routing";

const routing = createHermesSwitchyardRoutingIntent({
  efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
  capable: { provider: "openai-api", model: "gpt-5" },
});

describe("Switchyard binding transport", () => {
  it("round trips the public observations without accepting intent-only activation (#13863)", () => {
    const bindings = switchyardBindingFixture(routing);
    const encoded = encodeSwitchyardProviderBindings(bindings, routing);
    expect(
      readSwitchyardProviderBindingsEnvironment(
        { [HERMES_SWITCHYARD_BINDINGS_ENV]: encoded },
        routing,
      ),
    ).toEqual(bindings);
    expect(() => serializeHermesSwitchyardRouting(routing)).toThrow("provider state");
  });

  it.each([
    { field: "providerId", value: "sk-do-not-print" },
    { field: "resourceVersion", value: 0 },
    { field: "resourceVersion", value: 1.5 },
    { field: "resourceVersion", value: "1" },
    { field: "endpointUrl", value: "https://inference.local/v1" },
    { field: "endpointUrl", value: "https://api.openai.com.evil.test/v1" },
    { field: "credentialEnv", value: "OPENAI_API_KEY" },
    { field: "profileId", value: "nvidia" },
    { field: "profileSha256", value: "not-a-hash" },
    { field: "providerName", value: "provider;touch /tmp/owned" },
    { field: "apiKey", value: "test-secret-do-not-print" },
  ])(
    "rejects a malformed or foreign $field without printing its value (#13863)",
    ({ field, value }) => {
      const bindings = switchyardBindingFixture(routing);
      const invalid = {
        ...bindings,
        providers: [{ ...bindings.providers[0], [field]: value }, bindings.providers[1]],
      };
      expect(() => validateSwitchyardProviderBindings(invalid, routing)).toThrow("provider state");
      try {
        validateSwitchyardProviderBindings(invalid, routing);
      } catch (error) {
        expect(String(error)).not.toContain(String(value));
      }
    },
  );

  it.each([
    "missing",
    "duplicate",
    "unresolved-target",
    "changed-model",
    "changed-judge",
    "unknown-field",
  ])("rejects %s role state (#13863)", (change) => {
    const bindings = switchyardBindingFixture(routing);
    const value = {
      ...bindings,
      ...(change === "missing" ? { providers: bindings.providers.slice(0, 1) } : {}),
      ...(change === "duplicate"
        ? {
            providers: [
              bindings.providers[0],
              { ...bindings.providers[1], providerId: bindings.providers[0].providerId },
            ],
          }
        : {}),
      ...(change === "unresolved-target"
        ? { efficient: { ...bindings.efficient, providerId: "missing-id" } }
        : {}),
      ...(change === "changed-model"
        ? { capable: { ...bindings.capable, model: "another-model" } }
        : {}),
      ...(change === "changed-judge" ? { judge: { ...bindings.judge, target: "efficient" } } : {}),
      ...(change === "unknown-field" ? { apiKey: "test-secret" } : {}),
    };
    expect(() => validateSwitchyardProviderBindings(value, routing)).toThrow("provider state");
  });

  it.each([
    undefined,
    "",
    "invalid",
    "a".repeat(16_385),
    Buffer.from("{}").toString("base64"),
    Buffer.from("invalid-json").toString("base64"),
  ])("rejects missing or invalid binding transport (#13863)", (encoded) => {
    expect(() =>
      readSwitchyardProviderBindingsEnvironment(
        { [HERMES_SWITCHYARD_BINDINGS_ENV]: encoded },
        routing,
      ),
    ).toThrow("provider state");
  });
});
