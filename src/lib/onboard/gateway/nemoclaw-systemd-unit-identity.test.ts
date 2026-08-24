// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { matchesNemoclawGatewaySystemdUnit } from "./nemoclaw-systemd-unit-identity";

const GATEWAY_BINARY = "/home/nvidia/.local/bin/openshell-gateway";
const UNIT_TEMPLATE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../scripts/lib/openshell-gateway.service.in",
);
const UNIT_TEMPLATE = fs.readFileSync(UNIT_TEMPLATE_PATH, "utf8");
const UNIT = UNIT_TEMPLATE.replaceAll("@OPENSHELL_GATEWAY_BIN@", GATEWAY_BINARY);

describe("NemoClaw gateway systemd unit identity", () => {
  it("matches the canonical repository-owned service template (#9705)", () => {
    const readFileSync = vi.spyOn(fs, "readFileSync");

    expect(matchesNemoclawGatewaySystemdUnit(UNIT, GATEWAY_BINARY)).toBe(true);
    expect(readFileSync).toHaveBeenCalledWith(UNIT_TEMPLATE_PATH, "utf8");
  });

  it("rejects a unit when the canonical service template cannot be read (#9705)", () => {
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("read denied");
    });

    expect(matchesNemoclawGatewaySystemdUnit(UNIT, GATEWAY_BINARY)).toBe(false);
  });

  it("accepts an allowed directive change from the canonical template owner (#9705)", () => {
    const changedTemplate = UNIT_TEMPLATE.replace("RestartSec=5s", "RestartSec=6s");
    const changedUnit = changedTemplate.replaceAll("@OPENSHELL_GATEWAY_BIN@", GATEWAY_BINARY);
    vi.spyOn(fs, "readFileSync").mockReturnValueOnce(changedTemplate);

    expect(matchesNemoclawGatewaySystemdUnit(changedUnit, GATEWAY_BINARY)).toBe(true);
  });

  it.each([
    ["an extra environment directive", "Environment=LD_PRELOAD=/tmp/foreign.so\n"],
    ["an extra start command", "ExecStart=/tmp/foreign-gateway\n"],
    ["an extra stop command", "ExecStop=/tmp/foreign-stop\n"],
  ])("rejects a unit with %s (#9705)", (_case, directive) => {
    expect(
      matchesNemoclawGatewaySystemdUnit(
        UNIT.replace("[Service]\n", `[Service]\n${directive}`),
        GATEWAY_BINARY,
      ),
    ).toBe(false);
  });

  it.each([
    [
      "the environment file",
      "EnvironmentFile=-%E/openshell/gateway.env",
      "EnvironmentFile=/tmp/foreign.env",
    ],
    ["the private temporary directory", "PrivateTmp=true", "PrivateTmp=false"],
    ["the gateway executable", GATEWAY_BINARY, "/tmp/foreign-gateway"],
  ])("rejects a unit that changes %s (#9705)", (_case, expected, replacement) => {
    expect(
      matchesNemoclawGatewaySystemdUnit(UNIT.replace(expected, replacement), GATEWAY_BINARY),
    ).toBe(false);
  });
});
