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

const NETWORK_POLICIES_SOURCE = "reference/network-policies.mdx";
const CUSTOMIZE_POLICY_SOURCE = "network-policy/customize-network-policy.mdx";
const INTEGRATION_POLICY_SOURCE = "network-policy/integration-policy-examples.mdx";
const GMAIL_SOURCE = "network-policy/set-up-gmail-with-an-app-password.mdx";
const APPROVAL_LINK_TEXT = "Approve or Deny Agent Network Requests";
const GMAIL_LINK_TEXT = "Set Up Gmail With an App Password";
const CONFIGURATION_SOURCES = [
  "network-policy/change-baseline-network-policy.mdx",
  "network-policy/apply-policy-presets.mdx",
  "network-policy/create-custom-policy-presets.mdx",
  "network-policy/configure-raw-tls-passthrough.mdx",
  "network-policy/replace-live-network-policy.mdx",
] as const;

function readDoc(source: string): string {
  return readFileSync(path.join(process.cwd(), "docs", source), "utf8");
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

  it("publishes focused policy configuration pages for OpenClaw and Hermes", () => {
    const index = buildPublishedRouteIndex();

    for (const source of CONFIGURATION_SOURCES) {
      expect(
        index.sourceToRoutes
          .get(source)
          ?.map(({ route }) => route)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual([
        `/user-guide/hermes/network-policy/configure-policies/${source
          .split("/")
          .at(-1)
          ?.replace(/\.mdx$/, "")}`,
        `/user-guide/openclaw/network-policy/configure-policies/${source
          .split("/")
          .at(-1)
          ?.replace(/\.mdx$/, "")}`,
      ]);
      expect(findBrokenPublishedRoutes(source, index)).toEqual([]);
    }
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

  it("preserves compatibility anchors on the retained policy routes", () => {
    expect(readDoc(CUSTOMIZE_POLICY_SOURCE)).toContain("## Custom Preset Files");
    expect(readDoc(INTEGRATION_POLICY_SOURCE)).toContain("## Gmail With an App Password");
  });
});
