// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildVllmRunArgs, detectVllmProfile } from "./vllm";

describe("managed vLLM host bindings", () => {
  it.each([undefined, true] as const)(
    "publishes the default port on loopback and the OpenShell bridge when managed bearer authentication is %s (#14083)",
    (managedBearerAuth) => {
      const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
      const model = { ...profile.defaultModel, managedBearerAuth };
      const args = buildVllmRunArgs(
        profile,
        model,
        profile.dockerRunFlags,
        {
          VLLM_API_KEY: "a".repeat(64),
        },
        "172.18.0.1",
      );
      const bindings = args.flatMap((value, index) => (value === "-p" ? [args[index + 1]] : []));

      expect(bindings).toEqual(["127.0.0.1:8000:8000", "172.18.0.1:8000:8000"]);
      expect(bindings.join(" ")).not.toMatch(/(?:0\.0\.0\.0|\[?::\]?):8000/u);
    },
  );
});
