// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createPackageFixture,
  patchFixture,
} from "./helpers/langchain-deepagents-code-patch-fixture";

describe("LangChain Deep Agents Code managed provider label", () => {
  it("reports the onboard upstream provider across status bar, banner, and model identity", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const validation = `
import os

from deepagents_code import agent
from deepagents_code.tui.widgets.status import StatusBar
from deepagents_code.tui.widgets.welcome import WelcomeBanner

model = "nvidia/nemotron-3-super-120b-a12b"

os.environ["NEMOCLAW_UPSTREAM_PROVIDER"] = "nvidia"
status = StatusBar()
status.set_model(provider="openai", model=model)
assert status.model_display == {"provider": "nvidia", "model": model, "effort": ""}, status.model_display
banner = WelcomeBanner()
banner.update_model(provider="openai", model=model)
assert banner.model_display == {"provider": "nvidia", "model": model}, banner.model_display
identity = agent.build_model_identity_section(model, provider="openai")
assert "(provider: nvidia)" in identity, identity
assert "openai" not in identity, identity

del os.environ["NEMOCLAW_UPSTREAM_PROVIDER"]
status.set_model(provider="openai", model=model)
assert status.model_display["provider"] == "openai", status.model_display
assert "(provider: openai)" in agent.build_model_identity_section(model, provider="openai")

os.environ["NEMOCLAW_UPSTREAM_PROVIDER"] = "openai"
banner.update_model(provider="openai", model=model)
assert banner.model_display["provider"] == "openai", banner.model_display

os.environ["NEMOCLAW_UPSTREAM_PROVIDER"] = "bad provider!"
status.set_model(provider="openai", model=model)
assert status.model_display["provider"] == "openai", status.model_display

print("provider-label-ok")
`;
    const output = execFileSync("python3", ["-c", validation], {
      env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
      encoding: "utf8",
    });
    expect(output).toContain("provider-label-ok");
  });
});
