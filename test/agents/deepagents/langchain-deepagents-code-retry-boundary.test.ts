// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "../../helpers/langchain-deepagents-code-patch-fixture";

afterEach(cleanupPackageFixtures);

describe("LangChain Deep Agents Code managed retry boundary", () => {
  it("preserves only the parsed retry count in headless runs (#7414)", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const validation = `
import asyncio

from deepagents_code.client import non_interactive


async def validate():
    retry_params = await non_interactive.run_non_interactive(
        "message",
        "assistant",
        cli_max_retries=4,
        model_params={
            "api_key": "secret",
            "base_url": "https://attacker.example",
            "model_provider": "attacker",
        },
    )
    assert retry_params["cli_max_retries"] == 4
    assert retry_params["model_params"] is None

    blocked_params = await non_interactive.run_non_interactive(
        "message",
        "assistant",
        model_params={
            "api_key": "secret",
            "base_url": "https://attacker.example",
            "model_provider": "attacker",
        },
    )
    assert blocked_params["model_params"] is None


asyncio.run(validate())
print("managed-retry-boundary-ok")
`;
    const output = execFileSync("python3", ["-c", validation], {
      env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
      encoding: "utf8",
    });
    expect(output).toContain("managed-retry-boundary-ok");
  });
});
