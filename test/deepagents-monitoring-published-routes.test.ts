// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  buildPublishedRouteIndex,
  findBrokenPublishedRoutes,
  resolvePageLinksByText,
} from "../scripts/check-docs-published-routes.mts";

const TRACE_SOURCES = [
  "monitoring/understand-deepagents-trace-export.mdx",
  "monitoring/set-up-deepagents-trace-export.mdx",
  "monitoring/verify-deepagents-trace-export.mdx",
  "monitoring/manage-deepagents-trace-export.mdx",
] as const;
const QUICKSTART_SOURCE = "get-started/quickstart-langchain-deepagents-code.mdx";

function readDoc(source: string): string {
  return readFileSync(path.join(process.cwd(), "docs", source), "utf8");
}

describe("Deep Agents monitoring published routes", () => {
  it("publishes focused trace pages only in the Deep Agents guide", () => {
    const index = buildPublishedRouteIndex();

    for (const source of TRACE_SOURCES) {
      const slug = source
        .split("/")
        .at(-1)
        ?.replace(/\.mdx$/, "");
      expect(index.sourceToRoutes.get(source)?.map(({ route }) => route)).toEqual([
        `/user-guide/deepagents/monitoring/${slug}`,
      ]);
      expect(findBrokenPublishedRoutes(source, index)).toEqual([]);
      expect(index.routes.has(`/user-guide/openclaw/monitoring/${slug}`)).toBe(false);
      expect(index.routes.has(`/user-guide/hermes/monitoring/${slug}`)).toBe(false);
    }
  });

  it("keeps the Quickstart compatibility pointer on the focused setup path", () => {
    const index = buildPublishedRouteIndex();

    expect(findBrokenPublishedRoutes(QUICKSTART_SOURCE, index)).toEqual([]);
    expect([
      ...resolvePageLinksByText(QUICKSTART_SOURCE, "Set Up Deep Agents Trace Export", index),
    ]).toEqual([
      {
        fromRoute: "/user-guide/deepagents/get-started/quickstart",
        published: true,
        resolved: "/user-guide/deepagents/monitoring/set-up-deepagents-trace-export",
        target: "../monitoring/set-up-deepagents-trace-export",
      },
    ]);
    expect(readDoc(QUICKSTART_SOURCE)).toContain('id="export-traces-through-a-local-collector"');
  });
});
