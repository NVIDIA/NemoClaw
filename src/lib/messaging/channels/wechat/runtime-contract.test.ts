// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { wechatManifest } from "./manifest";

const openclawPolicy = YAML.parse(
  readFileSync(new URL("./policy/openclaw.yaml", import.meta.url), "utf8"),
) as {
  network_policies: {
    wechat_bridge: { binaries: Array<{ path: string }> };
  };
};

describe("WeChat runtime security contract", () => {
  it("grants the OpenClaw credential only to its Node runtimes", () => {
    expect(openclawPolicy.network_policies.wechat_bridge.binaries).toEqual([
      { path: "/usr/local/bin/node" },
      { path: "/usr/bin/node" },
    ]);
  });

  it("owns the account refresh through a required boot preload", () => {
    expect(wechatManifest.runtime?.openclaw?.nodePreloads).toContainEqual({
      module: "wechat-account-placeholder",
      injectInto: ["boot"],
      optional: false,
    });
  });
});
