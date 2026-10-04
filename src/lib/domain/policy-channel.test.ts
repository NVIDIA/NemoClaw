// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parsePolicyAddOptions } from "./policy-channel";

describe("policy channel helpers", () => {
  it("parses policy add options without reconstructing CLI argv", () => {
    expect(
      parsePolicyAddOptions(
        { preset: "github", dryRun: true, yes: true, fromFile: "preset.yaml" },
        {},
      ),
    ).toEqual({
      dryRun: true,
      skipConfirm: true,
      source: { kind: "file", path: "preset.yaml" },
      presetArg: "github",
      trustedPrivateHosts: [],
      commandTrustedPrivateHosts: [],
    });
  });

  it("parses policy add option errors", () => {
    expect(parsePolicyAddOptions({ fromFile: "a.yaml", fromDir: "dir" }, {}, true)).toEqual({
      dryRun: false,
      skipConfirm: false,
      source: { kind: "error", message: "--from-file and --from-dir are mutually exclusive." },
      presetArg: null,
      trustedPrivateHosts: [],
      commandTrustedPrivateHosts: [],
    });
    expect(parsePolicyAddOptions({ fromFile: "" }, {}, true)).toEqual({
      dryRun: false,
      skipConfirm: false,
      source: { kind: "error", message: "--from-file requires a path argument." },
      presetArg: null,
      trustedPrivateHosts: [],
      commandTrustedPrivateHosts: [],
    });
  });

  it("limits trusted private hosts to custom policy input (#8176)", () => {
    expect(parsePolicyAddOptions({ trustedPrivateHosts: ["api.corp.example"] }, {}, true)).toEqual({
      dryRun: false,
      skipConfirm: false,
      source: {
        kind: "error",
        message: "--trusted-private-host requires --from-file or --from-dir.",
      },
      presetArg: null,
      trustedPrivateHosts: ["api.corp.example"],
      commandTrustedPrivateHosts: ["api.corp.example"],
    });

    expect(
      parsePolicyAddOptions(
        { fromFile: "preset.yaml", trustedPrivateHosts: ["api.corp.example"] },
        {},
      ).trustedPrivateHosts,
    ).toEqual(["api.corp.example"]);

    expect(
      parsePolicyAddOptions(
        { fromFile: "preset.yaml" },
        { NEMOCLAW_TRUSTED_PRIVATE_HOSTS: "api.corp.example,other.corp.example" },
      ),
    ).toMatchObject({
      source: { kind: "file", path: "preset.yaml" },
      trustedPrivateHosts: ["api.corp.example", "other.corp.example"],
      commandTrustedPrivateHosts: [],
    });
  });

  it("detects policy confirmation bypass options", () => {
    expect(parsePolicyAddOptions({ yes: true }, {}, true).skipConfirm).toBe(true);
    expect(parsePolicyAddOptions({ force: true }, {}, true).skipConfirm).toBe(true);
    expect(parsePolicyAddOptions({}, { NEMOCLAW_NON_INTERACTIVE: "1" }, true).skipConfirm).toBe(
      true,
    );
    expect(parsePolicyAddOptions({}, {}, true).skipConfirm).toBe(false);
  });

  it("skips the confirmation prompt in a session without a terminal (#8877)", () => {
    expect(parsePolicyAddOptions({}, {}, false).skipConfirm).toBe(true);
  });
});
