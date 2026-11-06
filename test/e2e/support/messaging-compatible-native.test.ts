// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import vm from "node:vm";
import { expect, it, vi } from "vitest";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  assertOpenClawConfigShape,
  onboardEnv,
} from "../live/messaging-compatible-endpoint.test.ts";

// Register no live target while exercising its configuration probe in isolation.
vi.mock("../fixtures/e2e-test.ts", async () => ({
  expect: (await import("vitest")).expect,
  test: vi.fn(),
}));

const endpointUrl = "http://10.20.30.40:18089/v1";
const reference = "openshell:resolve:env:v7_COMPATIBLE_API_KEY";

it("admits only the mock endpoint host for native onboarding", () => {
  expect(onboardEnv(endpointUrl)).toMatchObject({
    NEMOCLAW_ENDPOINT_URL: endpointUrl,
    NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS: "10.20.30.40",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_PREFERRED_API: "openai-completions",
  });
});

it.each([
  { label: "scoped reference", baseUrl: endpointUrl, apiKey: reference, status: 0 },
  { label: "raw credential", baseUrl: endpointUrl, apiKey: "raw-test-credential", status: 1 },
  {
    label: "unscoped reference",
    baseUrl: endpointUrl,
    apiKey: "openshell:resolve:env:COMPATIBLE_API_KEY",
    status: 1,
  },
  {
    label: "different revision",
    baseUrl: endpointUrl,
    apiKey: "openshell:resolve:env:v8_COMPATIBLE_API_KEY",
    status: 1,
  },
  { label: "retired route", baseUrl: "https://inference.local/v1", apiKey: reference, status: 1 },
])("checks the native config with $label", async ({ baseUrl, apiKey, status }) => {
  const exitStatuses: number[] = [];
  const sandbox = {
    exec: async (_name: string, args: string[]) => {
      const config = {
        models: { providers: { inference: { baseUrl, apiKey } } },
        agents: { defaults: { model: { primary: "inference/" + args[3] } } },
        channels: { telegram: {} },
      };
      vm.runInNewContext(args[2]!, {
        require: () => ({ readFileSync: () => JSON.stringify(config) }),
        process: {
          argv: ["node", ...args.slice(3)],
          env: { COMPATIBLE_API_KEY: reference },
          exit: (code: number) => exitStatuses.push(code),
        },
        console: { log: () => undefined },
      });
      return { exitCode: exitStatuses.at(-1), stdout: "", stderr: "" };
    },
  } as unknown as SandboxClient;
  const result = await assertOpenClawConfigShape(sandbox, endpointUrl).then(
    () => "accepted",
    () => "rejected",
  );
  expect({ exitStatuses, result }).toEqual({
    exitStatuses: [status],
    result: status === 0 ? "accepted" : "rejected",
  });
});
