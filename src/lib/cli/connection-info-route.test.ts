// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { sandboxActionTokens } from "./command-registry";
import { sandboxRouteTokens } from "./public-route-metadata";

describe("connection info public route (#7473)", () => {
  it("maps the nested command id onto the connection info grammar", () => {
    expect(sandboxRouteTokens("sandbox:connection:info")).toEqual(["connection", "info"]);
  });

  it("registers connection as a valid public sandbox action", () => {
    expect(sandboxActionTokens()).toContain("connection");
  });
});
