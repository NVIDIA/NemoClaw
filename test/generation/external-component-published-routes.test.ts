// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildPublishedRouteIndex,
  findBrokenPublishedRoutes,
  resolvePageLinksByText,
} from "../../scripts/check-docs-published-routes.mts";

describe("external component documentation routes", () => {
  it("links providerless onboarding to each applicable provider guide (#11988)", () => {
    const source = "deployment/register-external-component.mdx";
    const index = buildPublishedRouteIndex();
    const links = resolvePageLinksByText(source, "Switch Inference Providers", index);

    expect(findBrokenPublishedRoutes(source, index)).toEqual([]);
    expect(links).toHaveLength(2);
    expect(links).toEqual(
      expect.arrayContaining(
        ["openclaw", "hermes"].map((variant) =>
          expect.objectContaining({
            fromRoute: `/user-guide/${variant}/deployment/register-external-component`,
            resolved: `/user-guide/${variant}/inference/manage-inference/switch-providers`,
            published: true,
          }),
        ),
      ),
    );
  });
});
