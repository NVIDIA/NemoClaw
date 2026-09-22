// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { publishValidatedConfigExportYaml } from "../fixtures/phases/config-export-validation.ts";

describe("config export artifact publication", () => {
  it.each([
    ["base64 credential", (secret: string) => Buffer.from(secret, "utf8").toString("base64")],
    [
      "escaped credential",
      (secret: string) =>
        [...secret]
          .map((value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join(""),
    ],
    [
      "encoded internal transport",
      () => Buffer.from("openshell:resolve:env:KEY", "utf8").toString("base64"),
    ],
  ])("withholds YAML containing a %s representation", async (_name, represent) => {
    const writeText = vi.fn();
    const secret = "synthetic-publication-secret";
    const raw = `value: "${represent(secret)}"\n`;

    await expect(
      publishValidatedConfigExportYaml({ writeText }, "config-export.yaml", raw, [secret]),
    ).rejects.toThrow();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("publishes YAML after the complete scan passes", async () => {
    const writeText = vi.fn();
    const raw = "apiVersion: nemoclaw.nvidia.com/v1alpha1\nkind: NemoClawConfig\n";

    await expect(
      publishValidatedConfigExportYaml({ writeText }, "config-export.yaml", raw, ["secret"]),
    ).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("config-export.yaml", raw);
  });
});
