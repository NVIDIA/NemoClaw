// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { describe, it } from "vitest";

const require = createRequire(import.meta.url);
const fixtureMocks = require("./onboard-script-mocks.cjs") as {
  mockCreatedSandboxIdentityList(
    command: string[],
    options?: { sandboxName: string; sandboxId: string },
  ): string | null;
  mockPublishedCreatedSandboxGet(command: string[]): {
    status: number;
    stdout: Buffer;
    stderr: Buffer;
  } | null;
};

describe("onboarding script fixtures", () => {
  it("publishes the settled durable sandbox ID through sandbox get", () => {
    const identityList = fixtureMocks.mockCreatedSandboxIdentityList(
      [
        "openshell",
        "sandbox",
        "list",
        "--output",
        "json",
        "--selector",
        "ai.nvidia.nemoclaw.create-attempt=fixture-attempt",
      ],
      { sandboxName: "my-assistant", sandboxId: "sbx-created" },
    );

    assert.ok(identityList);
    assert.match(
      fixtureMocks.mockCreatedSandboxIdentityList([
        "openshell",
        "sandbox",
        "get",
        "-g",
        "nemoclaw",
        "my-assistant",
      ]) ?? "",
      /^Id: sbx-created$/m,
    );
    const published = fixtureMocks.mockPublishedCreatedSandboxGet([
      "openshell",
      "sandbox",
      "get",
      "-g",
      "nemoclaw",
      "my-assistant",
    ]);
    assert.equal(published?.status, 0);
    assert.match(published?.stdout.toString() ?? "", /^Name: my-assistant$/m);
    assert.match(published?.stdout.toString() ?? "", /^Id: sbx-created$/m);
    assert.equal(
      fixtureMocks.mockPublishedCreatedSandboxGet([
        "openshell",
        "sandbox",
        "get",
        "-g",
        "nemoclaw",
        "other-sandbox",
      ]),
      null,
    );
  });
});
