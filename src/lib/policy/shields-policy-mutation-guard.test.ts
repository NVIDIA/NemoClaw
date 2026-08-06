// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as runner from "../runner";
import { resolveNemoclawStateDir } from "../state/paths";
import * as registry from "../state/registry";
import {
  applyPermissivePolicy,
  applyPresetContent,
  applyPresets,
  excludeBaselineEntry,
  removePreset,
  restoreBaselineEntry,
} from "./index";

const sandboxName = "alpha";
const presetContent = "network_policies:\n  example:\n    endpoints: []\n";

describe("policy mutation guard during Shields-down", () => {
  beforeEach(() => {
    const stateDir = resolveNemoclawStateDir();
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(stateDir, `shields-${sandboxName}.json`),
      JSON.stringify({ shieldsDown: true, shieldsPolicySnapshotPath: "/tmp/snapshot.yaml" }),
      { mode: 0o600 },
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(path.join(resolveNemoclawStateDir(), `shields-${sandboxName}.json`), {
      force: true,
    });
  });

  it("blocks every ordinary live-policy entrypoint before gateway or journal writes (#8176)", () => {
    const run = vi.spyOn(runner, "run");
    const runCapture = vi.spyOn(runner, "runCapture");
    const updateSandbox = vi.spyOn(registry, "updateSandbox");
    const beginCustom = vi.spyOn(registry, "beginCustomPolicyTransition");
    const beginBaseline = vi.spyOn(registry, "beginBaselineExclusionTransition");

    expect(applyPresetContent(sandboxName, "custom", presetContent)).toBe(false);
    expect(removePreset(sandboxName, "custom")).toBe(false);
    expect(applyPresets(sandboxName, ["npm"])).toBe(false);
    expect(excludeBaselineEntry(sandboxName, "example", "a".repeat(64))).toBe(false);
    expect(restoreBaselineEntry(sandboxName, "example")).toBe(false);
    expect(() => applyPermissivePolicy(sandboxName)).toThrow(/Shields state blocks/);

    expect(run).not.toHaveBeenCalled();
    expect(runCapture).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(beginCustom).not.toHaveBeenCalled();
    expect(beginBaseline).not.toHaveBeenCalled();
  });
});
