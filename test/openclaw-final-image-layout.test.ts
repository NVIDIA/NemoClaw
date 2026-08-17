// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectManagedBootstrapNativeImageContract } from "./support/managed-bootstrap-image-contract";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");

function indexOfRequired(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function hasBuildKitRunMount(dockerfile: string): boolean {
  return dockerfile
    .replace(/\\\r?\n[ \t]*/gu, " ")
    .split(/\r?\n/u)
    .some((instruction) => {
      const runOptionPrefix = instruction.match(/^\s*RUN((?:\s+--\S+)*)/iu)?.[1] ?? "";
      return /(?:^|\s)--mount(?:=|$)/iu.test(runOptionPrefix);
    });
}

describe("OpenClaw final image layout", () => {
  it.each([
    ["same-line", "RUN --network=none --mount=type=cache,target=/tmp true", true],
    ["line-continuation", "RUN --security=sandbox \\\n  --mount=type=secret,id=token true", true],
    ["shell-command argument", "RUN printf '%s' --mount=type=cache", false],
  ] as const)("recognizes BuildKit mounts only in the RUN option prefix for %s form (#7611)", (_form, dockerfile, expected) => {
    expect(hasBuildKitRunMount(dockerfile)).toBe(expected);
  });

});
