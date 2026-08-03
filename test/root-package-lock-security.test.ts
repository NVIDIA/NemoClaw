// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type LockedPackage = {
  integrity?: string;
  resolved?: string;
  version?: string;
};

const ROOT = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8")) as {
  packages: Record<string, LockedPackage>;
};

const reviewedBraceExpansionCopies = {
  "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion": {
    version: "5.0.9",
    resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz",
    integrity:
      "sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==",
  },
  "node_modules/brace-expansion": {
    version: "5.0.9",
    resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz",
    integrity:
      "sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==",
  },
  "node_modules/filelist/node_modules/brace-expansion": {
    version: "2.1.4",
    resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-2.1.4.tgz",
    integrity:
      "sha512-hGfVzPxthbf3+2yjg/RBs60cB0FhqBS/zvdV/4wn4/BmN0bNMMHPc4V/BbFieqf1TKAGGAHnY4eSjajCl0f2Xg==",
  },
};

describe("root dependency lock security", () => {
  // source-shape-contract: security -- Exact root lock identities keep every brace-expansion copy outside the affected advisory ranges
  it("pins every brace-expansion copy past the affected ranges", () => {
    const braceExpansionCopies = Object.fromEntries(
      Object.entries(lock.packages).filter(([packagePath]) =>
        packagePath.endsWith("node_modules/brace-expansion"),
      ),
    );

    expect(braceExpansionCopies).toMatchObject(reviewedBraceExpansionCopies);
    expect(Object.keys(braceExpansionCopies).sort()).toEqual(
      Object.keys(reviewedBraceExpansionCopies).sort(),
    );
  });
});
