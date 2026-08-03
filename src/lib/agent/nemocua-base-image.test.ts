// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it } from "vitest";

import { ROOT } from "../runner";
import { getNemoCuaBaseImageBuildArgs, NEMOCUA_RUNTIME_IMAGE_ENV } from "./nemocua-base-image";

const agent = { name: "nemocua", agentDir: path.join(ROOT, "agents", "nemocua") };
const digest = "sha256:c1a577fc8f69071642b97706130df26abd8a89b8bd429a9ef37abf0ccd634e0b";

describe("NemoCUA base image input", () => {
  it("passes only the manifest-pinned OCI image into the base build (#7755)", () => {
    const ref = `local.example/nvlumina@${digest}`;
    expect(getNemoCuaBaseImageBuildArgs(agent, { [NEMOCUA_RUNTIME_IMAGE_ENV]: ref })).toEqual({
      NEMOCUA_RUNTIME_IMAGE: ref,
    });
  });

  it("rejects a mutable or mismatched source image (#7755)", () => {
    expect(() =>
      getNemoCuaBaseImageBuildArgs(agent, {
        [NEMOCUA_RUNTIME_IMAGE_ENV]: "local.example/nvlumina:v0.0.5",
      }),
    ).toThrow("must be an immutable reference");
  });
});
