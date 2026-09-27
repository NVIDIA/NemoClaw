// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import {
  expandBaseImagePushPaths,
  matchesBaseImagePushPath,
} from "../../../tools/e2e/base-image-publication.mts";
import { readWorkflow } from "../../helpers/managed-image-publication-workflow";

const MCP_BRIDGE_SUPPORT_PATH = "test/e2e/support/mcp-bridge-portable-lock-barrier.ts";

it("keeps MCP bridge support in both image triggers and the publication selector (#12084)", () => {
  const managedPaths = readWorkflow("managed-images.yaml").on?.pull_request?.paths ?? [];
  const basePaths = readWorkflow("base-image.yaml").on?.push?.paths ?? [];

  expect(managedPaths.filter((candidate) => candidate === MCP_BRIDGE_SUPPORT_PATH)).toEqual([
    MCP_BRIDGE_SUPPORT_PATH,
  ]);
  expect(basePaths.filter((candidate) => candidate === MCP_BRIDGE_SUPPORT_PATH)).toEqual([
    MCP_BRIDGE_SUPPORT_PATH,
  ]);
  expect(expandBaseImagePushPaths("a".repeat(40), [MCP_BRIDGE_SUPPORT_PATH])).toEqual([
    `:(glob)${MCP_BRIDGE_SUPPORT_PATH}`,
  ]);
  expect(
    matchesBaseImagePushPath(
      MCP_BRIDGE_SUPPORT_PATH,
      "test/e2e/support/mcp-bridge-portable-lock-barrier.ts",
    ),
  ).toBe(true);
  expect(
    matchesBaseImagePushPath(
      MCP_BRIDGE_SUPPORT_PATH,
      "test/e2e/support/nested/mcp-bridge-portable-lock-barrier.ts",
    ),
  ).toBe(false);
});
