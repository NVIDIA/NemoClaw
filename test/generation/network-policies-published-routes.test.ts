// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  buildPublishedRouteIndex,
  findBrokenPublishedRoutes,
  resolvePageLinksByText,
} from "../../scripts/check-docs-published-routes.mts";
import { renderAgentVariantPage } from "../../scripts/sync-agent-variant-docs.mts";

const NETWORK_POLICIES_SOURCE = "reference/network-policies.mdx";
const APPROVAL_SOURCE = "network-policy/approve-network-requests.mdx";
const CUSTOMIZE_POLICY_SOURCE = "network-policy/customize-network-policy.mdx";
const BASELINE_POLICY_SOURCE = "network-policy/change-baseline-network-policy.mdx";
const APPLY_PRESETS_SOURCE = "network-policy/apply-policy-presets.mdx";
const CUSTOM_PRESETS_SOURCE = "network-policy/create-custom-policy-presets.mdx";
const RAW_TLS_SOURCE = "network-policy/configure-raw-tls-passthrough.mdx";
const REPLACE_POLICY_SOURCE = "network-policy/replace-live-network-policy.mdx";
const INTEGRATION_POLICY_SOURCE = "network-policy/integration-policy-examples.mdx";
const GMAIL_SOURCE = "network-policy/set-up-gmail-with-an-app-password.mdx";
const APPROVAL_LINK_TEXT = "Approve or Deny Agent Network Requests";
const GMAIL_LINK_TEXT = "Set Up Gmail With an App Password";
const SHARED_CONFIGURATION_SOURCES = [
  BASELINE_POLICY_SOURCE,
  APPLY_PRESETS_SOURCE,
  CUSTOM_PRESETS_SOURCE,
  REPLACE_POLICY_SOURCE,
] as const;
const DEEPAGENTS_POLICY_ROUTES = [
  "/user-guide/deepagents/network-policy/approve-network-requests",
  "/user-guide/deepagents/network-policy/customize-network-policy",
  "/user-guide/deepagents/network-policy/configure-policies/change-baseline-network-policy",
  "/user-guide/deepagents/network-policy/configure-policies/apply-policy-presets",
  "/user-guide/deepagents/network-policy/configure-policies/create-custom-policy-presets",
  "/user-guide/deepagents/network-policy/configure-policies/replace-live-network-policy",
] as const;
const DEEPAGENTS_EXCLUDED_POLICY_ROUTES = [
  "/user-guide/deepagents/network-policy/configure-policies/configure-raw-tls-passthrough",
  "/user-guide/deepagents/network-policy/explain-network-policy-to-agents",
  "/user-guide/deepagents/network-policy/integration-policy-examples",
  "/user-guide/deepagents/network-policy/set-up-gmail-with-an-app-password",
] as const;
const LEGACY_CUSTOMIZE_POLICY_POINTERS = [
  {
    anchors: [
      "prerequisites",
      "edit-the-policy-file",
      "re-run-onboard",
      "verify-the-policy",
      "add-blueprint-policy-additions",
    ],
    target: "configure-policies/change-baseline-network-policy",
  },
  {
    anchors: ["scope-of-dynamic-changes", "add-a-preset-file-with-policy-add-recommended"],
    target: "configure-policies/apply-policy-presets",
  },
  {
    anchors: ["approve-requests-interactively"],
    target: "approve-network-requests",
  },
  {
    anchors: [
      "authoring",
      "apply-a-single-file",
      "apply-every-file-in-a-directory",
      "remove-a-custom-preset",
      "custom-recipe-url-based-mcp-server",
    ],
    target: "configure-policies/create-custom-policy-presets",
  },
  {
    anchors: ["custom-recipe-for-raw-tls-passthrough-with-tls-skip"],
    target: "configure-policies/configure-raw-tls-passthrough",
  },
  {
    anchors: ["export-edit-and-set-the-base-policy"],
    target: "configure-policies/replace-live-network-policy",
  },
] as const;

function readDoc(source: string): string {
  return readFileSync(path.join(process.cwd(), "docs", source), "utf8");
}

function expectUniqueAnchorsBeforePointer(
  source: string,
  anchors: readonly string[],
  target: string,
): void {
  const pointer = `](${target})`;

  for (const anchor of anchors) {
    const marker = `<a id="${anchor}"></a>`;
    expect(source.split(marker)).toHaveLength(2);
    const anchorIndex = source.indexOf(marker);
    const pointerIndex = source.indexOf(pointer, anchorIndex + marker.length);
    expect(pointerIndex).toBeGreaterThan(anchorIndex);
    expect(source.slice(anchorIndex + marker.length, pointerIndex)).not.toContain("](");
  }
}

describe("shared Network Policies published routes", () => {
  it("keeps the approval guide link inside variants that publish it (#6601)", () => {
    const index = buildPublishedRouteIndex();

    expect(findBrokenPublishedRoutes(NETWORK_POLICIES_SOURCE, index)).toEqual([]);
    expect(
      [...resolvePageLinksByText(NETWORK_POLICIES_SOURCE, APPROVAL_LINK_TEXT, index)].sort((a, b) =>
        a.fromRoute.localeCompare(b.fromRoute),
      ),
    ).toEqual([
      {
        fromRoute: "/user-guide/deepagents/reference/network-policies",
        published: true,
        resolved: "/user-guide/deepagents/network-policy/approve-network-requests",
        target: "../network-policy/approve-network-requests",
      },
      {
        fromRoute: "/user-guide/hermes/reference/network-policies",
        published: true,
        resolved: "/user-guide/hermes/network-policy/approve-network-requests",
        target: "../network-policy/approve-network-requests",
      },
      {
        fromRoute: "/user-guide/openclaw/reference/network-policies",
        published: true,
        resolved: "/user-guide/openclaw/network-policy/approve-network-requests",
        target: "../network-policy/approve-network-requests",
      },
    ]);
  });

  it("resolves every customization guide link inside its published variants", () => {
    const index = buildPublishedRouteIndex();

    expect(findBrokenPublishedRoutes(CUSTOMIZE_POLICY_SOURCE, index)).toEqual([]);
  });

  it.each(DEEPAGENTS_POLICY_ROUTES)("publishes the Deep Agents policy route %s", (route) => {
    const index = buildPublishedRouteIndex();
    expect(index.routes.has(route), route).toBe(true);
  });

  it.each(DEEPAGENTS_EXCLUDED_POLICY_ROUTES)(
    "excludes the Deep Agents policy route %s",
    (route) => {
      const index = buildPublishedRouteIndex();
      expect(index.routes.has(route), route).toBe(false);
    },
  );

  it.each(SHARED_CONFIGURATION_SOURCES)(
    "publishes the shared %s policy page for every supported agent",
    (source) => {
      const index = buildPublishedRouteIndex();
      const slug = source
        .split("/")
        .at(-1)
        ?.replace(/\.mdx$/, "");
      expect(
        index.sourceToRoutes
          .get(source)
          ?.map(({ route }) => route)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual([
        `/user-guide/deepagents/network-policy/configure-policies/${slug}`,
        `/user-guide/hermes/network-policy/configure-policies/${slug}`,
        `/user-guide/openclaw/network-policy/configure-policies/${slug}`,
      ]);
      expect(findBrokenPublishedRoutes(source, index)).toEqual([]);
    },
  );

  it("keeps raw TLS configuration scoped to OpenClaw and Hermes", () => {
    const index = buildPublishedRouteIndex();

    expect(
      index.sourceToRoutes
        .get(RAW_TLS_SOURCE)
        ?.map(({ route }) => route)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      "/user-guide/hermes/network-policy/configure-policies/configure-raw-tls-passthrough",
      "/user-guide/openclaw/network-policy/configure-policies/configure-raw-tls-passthrough",
    ]);
    expect(findBrokenPublishedRoutes(RAW_TLS_SOURCE, index)).toEqual([]);
  });

  it("removes unsupported workflows from the Deep Agents page variants", () => {
    const approval = renderAgentVariantPage(readDoc(APPROVAL_SOURCE), "deepagents");
    const customize = renderAgentVariantPage(readDoc(CUSTOMIZE_POLICY_SOURCE), "deepagents");
    const baseline = renderAgentVariantPage(readDoc(BASELINE_POLICY_SOURCE), "deepagents");
    const presets = renderAgentVariantPage(readDoc(APPLY_PRESETS_SOURCE), "deepagents");
    const custom = renderAgentVariantPage(readDoc(CUSTOM_PRESETS_SOURCE), "deepagents");

    expect(approval).not.toContain("## Run the Walkthrough Script");
    expect(customize).not.toContain("Configure Raw TLS Passthrough");
    expect(customize).not.toContain("Explain Network Policy to Agents");
    expect(customize).not.toContain("Common Integration Policy Examples");
    expect(baseline).toContain("agents/langchain-deepagents-code/policy-additions.yaml");
    expect(presets).toContain("Deep Agents baseline, tier, Tavily, and observability");
    expect(presets).not.toContain("Common Integration Policy Examples");
    expect(presets).toContain("nemo-deepagents my-assistant policy add weather --dry-run");
    expect(presets).toContain("nemo-deepagents my-assistant policy remove weather --yes");
    expect(presets).not.toContain("nemo-deepagents my-assistant policy add pypi");
    expect(custom).toContain("/opt/venv/bin/python3*");
    expect(custom).not.toContain("## Configure a URL-Based MCP Server");
    expect(custom).not.toContain("Configure Raw TLS Passthrough");
  });

  it("publishes the Gmail task only where the integration hub is available", () => {
    const index = buildPublishedRouteIndex();

    expect(
      index.sourceToRoutes
        .get(GMAIL_SOURCE)
        ?.map(({ route }) => route)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      "/user-guide/hermes/network-policy/set-up-gmail-with-an-app-password",
      "/user-guide/openclaw/network-policy/set-up-gmail-with-an-app-password",
    ]);
    expect(findBrokenPublishedRoutes(GMAIL_SOURCE, index)).toEqual([]);
    expect(
      index.routes.has("/user-guide/deepagents/network-policy/set-up-gmail-with-an-app-password"),
    ).toBe(false);
  });

  it("keeps the Gmail compatibility section linked to its focused page", () => {
    const index = buildPublishedRouteIndex();

    expect(findBrokenPublishedRoutes(INTEGRATION_POLICY_SOURCE, index)).toEqual([]);
    expect(
      [...resolvePageLinksByText(INTEGRATION_POLICY_SOURCE, GMAIL_LINK_TEXT, index)].sort((a, b) =>
        a.fromRoute.localeCompare(b.fromRoute),
      ),
    ).toEqual([
      {
        fromRoute: "/user-guide/hermes/network-policy/integration-policy-examples",
        published: true,
        resolved: "/user-guide/hermes/network-policy/set-up-gmail-with-an-app-password",
        target: "set-up-gmail-with-an-app-password",
      },
      {
        fromRoute: "/user-guide/openclaw/network-policy/integration-policy-examples",
        published: true,
        resolved: "/user-guide/openclaw/network-policy/set-up-gmail-with-an-app-password",
        target: "set-up-gmail-with-an-app-password",
      },
    ]);
  });

  it.each(LEGACY_CUSTOMIZE_POLICY_POINTERS)(
    "preserves the compatibility anchors before $target (#7495)",
    ({ anchors, target }) => {
      const customizePolicy = readDoc(CUSTOMIZE_POLICY_SOURCE);
      expectUniqueAnchorsBeforePointer(customizePolicy, anchors, target);
    },
  );

  it("preserves retained policy sections (#7495)", () => {
    expect(readDoc(CUSTOMIZE_POLICY_SOURCE)).toContain("## Custom Preset Files");
    expect(readDoc(INTEGRATION_POLICY_SOURCE)).toContain("## Gmail With an App Password");
  });
});
