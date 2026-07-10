// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildPublishedRouteIndex,
  findBrokenPublishedRoutes,
  resolvePageLinksByText,
} from "../scripts/check-docs-published-routes.ts";

const NETWORK_POLICIES_SOURCE = "reference/network-policies.mdx";
const APPROVAL_LINK_TEXT = "Approve or Deny Agent Network Requests";

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
});
