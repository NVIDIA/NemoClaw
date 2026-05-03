// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveSandboxOclifDispatch } from "./legacy-oclif-dispatch";

describe("resolveSandboxOclifDispatch", () => {
  it("routes sandbox status through oclif", () => {
    expect(resolveSandboxOclifDispatch("alpha", "status", [])).toEqual({
      kind: "oclif",
      commandId: "sandbox:status",
      args: ["alpha"],
    });
  });

 it("keeps sandbox status help public", () => {
  expect(resolveSandboxOclifDispatch("alpha", "status", ["--help"])).toEqual({
    kind: "help",
    usage: "status",
  });
});

it("routes sandbox config set through oclif with security flags intact", () => {
  expect(
    resolveSandboxOclifDispatch("alpha", "config", [
      "set",
      "--key",
      "inference.endpoints",
      "--value",
      "HTTP://93.184.216.34/v1",
      "--config-accept-new-path",
    ]),
  ).toEqual({
    kind: "oclif",
    commandId: "sandbox:config:set",
    args: [
      "alpha",
      "--key",
      "inference.endpoints",
      "--value",
      "HTTP://93.184.216.34/v1",
      "--config-accept-new-path",
    ],
  });
});

it("keeps sandbox logs help public with supported filters", () => {
  expect(resolveSandboxOclifDispatch("alpha", "logs", ["--help"])).toEqual({
    kind: "help",
    usage: "logs [--follow] [--tail <lines>|-n <lines>] [--since <duration>]",
  });
});