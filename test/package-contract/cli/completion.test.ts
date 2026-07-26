// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Config as OclifConfig } from "@oclif/core";
import { describe, expect, it } from "vitest";

import { buildCompletionModel } from "../../../dist/lib/actions/completion";

function findCase(
  model: ReturnType<typeof buildCompletionModel>,
  scope: "global" | "sandbox",
  key: string,
) {
  return model[scope].find((entry) => entry.key === `${scope}:${key}`);
}

describe("compiled completion metadata", () => {
  it("tracks the repository's discovered oclif and public-route registries", async () => {
    const config = await OclifConfig.load(process.cwd());
    const model = buildCompletionModel(config.commands);

    expect(findCase(model, "global", "")?.candidates).toEqual(
      expect.arrayContaining(["help", "resources", "uninstall", "use", "version"]),
    );
    expect(findCase(model, "global", "")?.flags).toEqual(
      expect.arrayContaining(["--help", "--version", "-h", "-v"]),
    );
    expect(findCase(model, "global", "inference")?.candidates).toEqual(
      expect.arrayContaining(["get", "set"]),
    );
    expect(findCase(model, "sandbox", "sessions")?.candidates).toEqual(
      expect.arrayContaining(["delete", "export", "list", "reset"]),
    );
    expect(findCase(model, "sandbox", "gateway")?.candidates).toContain("restart");
    expect(findCase(model, "sandbox", "gateway-token")?.flags).toContain("--quiet");
  });
});
