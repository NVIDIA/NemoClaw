// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as policies from "../dist/lib/policy";

const requireForTest = createRequire(import.meta.url);
const YAML = requireForTest("yaml");

function requirePresetContent(content: string | null): string {
  expect(content).toBeTruthy();
  if (!content) {
    throw new Error("Expected preset content to be present");
  }
  return content;
}

function parsePresetYaml(presetName: string): Record<string, any> {
  return YAML.parse(requirePresetContent(policies.loadPreset(presetName))) as Record<string, any>;
}

describe("gemini preset", () => {
  it("routes the Google Gemini API with node and curl access", () => {
    const parsed = parsePresetYaml("gemini");
    const endpoints: Array<Record<string, unknown>> =
      parsed?.network_policies?.gemini?.endpoints ?? [];
    const endpoint = endpoints.find((item) => item.host === "generativelanguage.googleapis.com");
    if (!endpoint) throw new Error("expected generativelanguage.googleapis.com endpoint");

    expect(endpoint.port).toBe(443);
    expect(endpoint.protocol).toBe("rest");
    expect(endpoint.enforcement).toBe("enforce");
    expect(endpoint.rules).toEqual([
      { allow: { method: "GET", path: "/v1beta/openai/**" } },
      { allow: { method: "POST", path: "/v1beta/openai/**" } },
    ]);

    const binaries: Array<{ path: string }> = parsed?.network_policies?.gemini?.binaries ?? [];
    expect(binaries.map((entry) => entry.path).sort()).toEqual([
      "/usr/bin/curl",
      "/usr/bin/node",
      "/usr/local/bin/node",
    ]);
  });

  it("extracts hosts from gemini preset", () => {
    const content = requirePresetContent(policies.loadPreset("gemini"));
    const hosts = policies.getPresetEndpoints(content);
    expect(hosts).toEqual(["generativelanguage.googleapis.com"]);
  });
});
