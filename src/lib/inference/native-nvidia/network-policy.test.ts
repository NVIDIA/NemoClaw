// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { buildNativeNvidiaSandboxPolicy } from "./network-policy";
import { nativeNvidiaProviderProfilePath } from "./index";

afterEach(() => vi.restoreAllMocks());

describe("native NVIDIA static policy preparation", () => {
  it("preserves an existing matching native rule on repeated preparation (#12822)", () => {
    const prepared = buildNativeNvidiaSandboxPolicy("version: 1\nnetwork_policies: {}\n");
    expect(buildNativeNvidiaSandboxPolicy(prepared)).toBe(prepared);
  });

  it("rejects an existing conflicting native rule (#12822)", () => {
    expect(() =>
      buildNativeNvidiaSandboxPolicy(
        "version: 1\nnetwork_policies:\n  native_nvidia_inference: {name: native_nvidia_inference, endpoints: []}\n",
      ),
    ).toThrow("conflicts with the selected provider profile");
  });

  it("rejects a malformed checked-in provider profile (#12822)", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("{}");
    expect(() => buildNativeNvidiaSandboxPolicy("version: 1\n")).toThrow(
      "checked-in provider profile is invalid",
    );
  });

  it.each([
    { condition: "another profile ID", override: { id: "other-profile" } },
    { condition: "inference capability is disabled", override: { inference_capable: false } },
  ])("rejects the parsed profile when $condition (#12822)", ({ override }) => {
    const profile = YAML.parse(fs.readFileSync(nativeNvidiaProviderProfilePath(), "utf8"));
    vi.spyOn(fs, "readFileSync").mockReturnValue(YAML.stringify({ ...profile, ...override }));
    expect(() => buildNativeNvidiaSandboxPolicy("version: 1\n")).toThrow(
      "checked-in provider profile is invalid",
    );
  });
});
