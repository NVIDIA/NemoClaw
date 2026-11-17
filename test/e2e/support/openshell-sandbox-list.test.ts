// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  openshellListIncludesSandbox,
  sandboxPhaseFromList,
} from "../fixtures/openshell-sandbox-list.ts";

describe("OpenShell sandbox list rows", () => {
  it("recognizes the selected gateway's sandbox in a colored table without matching its sibling", () => {
    const list =
      "\x1B[1mNAME     \x1B[0m  CREATED             PHASE\n" +
      "e2e-cgp-a  2026-10-27 09:55:44  \x1B[32mReady\x1B[39m\n";

    expect(sandboxPhaseFromList(list, "e2e-cgp-a")).toBe("Ready");
    expect(openshellListIncludesSandbox(list, "e2e-cgp-a")).toBe(true);
    expect(openshellListIncludesSandbox(list, "e2e-cgp-b")).toBe(false);
  });

  it("matches a complete sandbox name and rejects an absent row", () => {
    const list = "NAME  CREATED  PHASE\ne2e-cgp-a-old  2026-10-27 09:55:44  Ready\n";

    expect(openshellListIncludesSandbox(list, "e2e-cgp-a")).toBe(false);
    expect(openshellListIncludesSandbox("NAME  CREATED  PHASE\n", "e2e-cgp-b")).toBe(false);
  });
});
