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
const LEGACY_TRACE_POINTERS = [
  {
    anchors: ["understand-the-export-boundary"],
    linkText: "Understand Deep Agents Trace Export",
    target: "../monitoring/understand-deepagents-trace-export",
  },
  {
    anchors: [
      "enable-trace-export",
      "recover-a-skipped-policy",
      "create-langsmith-credentials",
      "find-the-private-host-bind-address",
      "configure-the-collector",
      "start-and-verify-the-collector",
    ],
    linkText: "Set Up Deep Agents Trace Export",
    target: "../monitoring/set-up-deepagents-trace-export",
  },
  {
    anchors: ["verify-traces-end-to-end", "troubleshoot-trace-export"],
    linkText: "Verify Deep Agents Trace Export",
    target: "../monitoring/verify-deepagents-trace-export",
  },
  {
    anchors: ["stop-or-disable-trace-export"],
    linkText: "Manage Deep Agents Trace Export",
    target: "../monitoring/manage-deepagents-trace-export",
  },
] as const;

function readDoc(source: string): string {
  return readFileSync(path.join(process.cwd(), "docs", source), "utf8");
}

function expectUniqueAnchorsBeforePointer(
  source: string,
  anchors: readonly string[],
  linkText: string,
  target: string,
): void {
  const pointer = `[${linkText}](${target})`;

  for (const anchor of anchors) {
    const marker = `<a id="${anchor}"></a>`;
    expect(source.split(marker)).toHaveLength(2);
    const anchorIndex = source.indexOf(marker);
    const pointerIndex = source.indexOf(pointer, anchorIndex + marker.length);
    expect(pointerIndex).toBeGreaterThan(anchorIndex);
    expect(source.slice(anchorIndex + marker.length, pointerIndex)).not.toContain("](");
  }
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

  it("keeps every Quickstart trace fragment on the focused monitoring paths (#7495)", () => {
    const index = buildPublishedRouteIndex();
    const quickstart = readDoc(QUICKSTART_SOURCE);

    expect(findBrokenPublishedRoutes(QUICKSTART_SOURCE, index)).toEqual([]);
    for (const { anchors, linkText, target } of LEGACY_TRACE_POINTERS) {
      expect([...resolvePageLinksByText(QUICKSTART_SOURCE, linkText, index)]).toEqual([
        {
          fromRoute: "/user-guide/deepagents/get-started/quickstart",
          published: true,
          resolved: `/user-guide/deepagents/monitoring/${target.split("/").at(-1)}`,
          target,
        },
      ]);
      expectUniqueAnchorsBeforePointer(quickstart, anchors, linkText, target);
    }
    expect(quickstart).toContain('id="export-traces-through-a-local-collector"');
  });
});
