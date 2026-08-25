// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { expect, it } from "vitest";

it("documents the revision-scoped managed MCP credential placeholder (#10298)", () => {
  const guide = fs.readFileSync("docs/manage-sandboxes/add-mcp-server.mdx", "utf8");

  expect(guide).toContain("openshell:resolve:env:v<revision>_LOCAL_MCP_TOKEN");
  expect(guide).not.toContain("`openshell:resolve:env:LOCAL_MCP_TOKEN` credential placeholder");
});
