// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv } from "../helpers/openclaw-env-fixture";

const BASE_ENV = baseOpenClawGenerationEnv();

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tool-disclosure-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("generate-openclaw-config.mts: tool disclosure", () => {
  it("uses only OpenClaw's camel-case structured Tool Search key by default", () => {
    const config = buildConfig(BASE_ENV);

    expect(config.tools?.toolSearch).toEqual({
      mode: "tools",
      searchDefaultLimit: 8,
      maxSearchLimit: 20,
    });
    expect(config.tools?.tool_search).toBeUndefined();
  });

  it("restores direct tool exposure through the agent-neutral override", () => {
    const config = buildConfig({ ...BASE_ENV, NEMOCLAW_TOOL_DISCLOSURE: "direct" });

    expect(config.tools?.toolSearch).toBe(false);
  });

  it("rejects unknown tool-disclosure modes", () => {
    expect(() => buildConfig({ ...BASE_ENV, NEMOCLAW_TOOL_DISCLOSURE: "sometimes" })).toThrow(
      "NEMOCLAW_TOOL_DISCLOSURE must be progressive or direct",
    );
  });

  it("does not let a model setup re-enable Tool Search over a direct request", () => {
    const registryDir = path.join(tmpDir, "model-specific-setup");
    const manifestPath = path.join(registryDir, "openclaw", "tool-search-on.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        id: "tool-search-on",
        agent: "openclaw",
        description: "Legacy code-mode override",
        match: { modelIds: ["test-model"] },
        effects: { openclawTools: { toolSearch: true } },
      }),
    );

    const config = buildConfig({
      ...BASE_ENV,
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir,
      NEMOCLAW_TOOL_DISCLOSURE: "direct",
    });

    expect(config.tools?.toolSearch).toBe(false);
  });
});
