// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { matchesNemoclawGatewaySystemdUnit } from "./nemoclaw-systemd-unit-identity";

const GATEWAY_BINARY = "/home/nvidia/.local/bin/openshell-gateway";
const UNIT_TEMPLATE = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../../../scripts/lib/openshell-gateway.service.in"),
  "utf-8",
);
const UNIT = UNIT_TEMPLATE.replaceAll("@OPENSHELL_GATEWAY_BIN@", GATEWAY_BINARY);

describe("NemoClaw gateway systemd unit identity", () => {
  it("matches the complete repository-owned service template (#9705)", () => {
    expect(matchesNemoclawGatewaySystemdUnit(UNIT, GATEWAY_BINARY)).toBe(true);
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
