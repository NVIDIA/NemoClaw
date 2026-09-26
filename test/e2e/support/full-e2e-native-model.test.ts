// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import {
  buildNativeModelRestartFixture,
  withNativeModelCleanup,
} from "../live/full-e2e-native-model.ts";

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

it("returns the verification result after restoring and removing the native test provider", async () => {
  const calls: string[] = [];
  const result = withNativeModelCleanup(
    async () => {
      calls.push("verification");
      return "verified";
    },
    async () => {
      calls.push("restoration");
    },
    async () => {
      calls.push("removal");
    },
  );
  await expect(result).resolves.toBe("verified");
  expect(calls).toEqual(["verification", "restoration", "removal"]);
});

it.each([0, 1, 2])("runs native model cleanup in order when step %i fails", async (failure) => {
  const error = new Error(`${failure} failed`);
  const calls: string[] = [];
  const steps = ["verification", "restoration", "removal"].map((name) => async () => {
    calls.push(name);
  });
  const failedStep = steps[failure];
  steps[failure] = async () => {
    await failedStep();
    throw error;
  };
  await expect(withNativeModelCleanup(steps[0], steps[1], steps[2])).rejects.toBe(error);
  expect(calls).toEqual(["verification", "restoration", "removal"]);
});

it("reports the last cleanup failure when verification and both cleanup steps fail", async () => {
  const errors = [new Error("verification"), new Error("restore"), new Error("remove")];
  const fail = (error: Error) => async () => {
    throw error;
  };
  await expect(
    withNativeModelCleanup(fail(errors[0]), fail(errors[1]), fail(errors[2])),
  ).rejects.toBe(errors[2]);
});
