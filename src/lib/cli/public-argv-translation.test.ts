// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { translatePublicGlobalArgv } from "./public-argv-translation";

/** Keep unknown actions on the public error path without changing valid dispatch or help. */
describe("global subcommand usage", () => {
  it.each([
    { command: "tunnel", actions: ["start", "stop", "status"] },
    { command: "agents", actions: ["list"] },
    { command: "credentials", actions: ["list", "add", "reset"] },
    { command: "inference", actions: ["get", "set"] },
  ])(
    "lists registered actions for an unknown $command subcommand (#11996)",
    ({ command, actions }) => {
      const result = translatePublicGlobalArgv(command, ["bogus", "private-argument"]);
      expect(result).toEqual({
        kind: "publicUsageError",
        lines: expect.arrayContaining([`${command} <subcommand>`, ...actions]),
      });
      expect(JSON.stringify(result)).not.toContain("private-argument");
    },
  );

  it.each([{ args: [] }, { args: ["help"] }, { args: ["--help"] }, { args: ["-h"] }])(
    "keeps tunnel help successful for $args",
    ({ args }) => {
      expect(translatePublicGlobalArgv("tunnel", args)).toMatchObject({
        kind: "nativeArgv",
        commandId: "tunnel",
        args: ["--help"],
      });
    },
  );

  it.each(["start", "stop", "status"])("keeps the registered tunnel %s action", (action) => {
    expect(translatePublicGlobalArgv("tunnel", [action, "--help"])).toMatchObject({
      kind: "nativeArgv",
      commandId: `tunnel:${action}`,
      args: ["--help"],
    });
  });
});
