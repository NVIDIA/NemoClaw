// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { buildNativeModelRestartFixture } from "../live/full-e2e-native-model.ts";

it("selects the qualified model through a credential-free native provider", () => {
  const model = "vendor/valid-model";
  const fixture = buildNativeModelRestartFixture(model);
  expect(fixture.provider).toMatch(/^nemoclaw-e2e-native-[0-9a-f-]{36}$/u);
  expect(fixture.primary).toBe(`${fixture.provider}/${model}`);
  expect(fixture.model).toBe(model);
  expect(JSON.parse(fixture.patch)).toEqual({
    models: {
      providers: {
        [fixture.provider]: {
          baseUrl: "https://inference.local/v1",
          apiKey: "unused",
          api: "openai-completions",
          models: [{ id: model, name: model }],
        },
      },
    },
    agents: {
      defaults: { model: { primary: fixture.primary }, models: { [fixture.primary]: {} } },
    },
  });
});

it("gives separate invocations different temporary provider and model entries", () => {
  const first = buildNativeModelRestartFixture("vendor/model");
  const second = buildNativeModelRestartFixture("vendor/model");
  expect(first.provider).not.toBe(second.provider);
  expect(first.primary).not.toBe(second.primary);
});

it("encodes model identifiers as JSON data without interpreting path or shell syntax", () => {
  const model = 'vendor/a.b[0]"; $(not-a-command)';
  const fixture = buildNativeModelRestartFixture(model);
  const patch = JSON.parse(fixture.patch);
  expect(patch.models.providers[fixture.provider].models[0].id).toBe(model);
  expect(patch.agents.defaults.model.primary).toBe(`${fixture.provider}/${model}`);
  expect(Object.keys(patch.agents.defaults.models)).toEqual([fixture.primary]);
});
