// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const MESSAGING_PLAN_ENV_KEY = "NEMOCLAW_MESSAGING_PLAN_B64";

function dockerfileEnvNames(dockerfile: string): string[] {
  const directives = dockerfile.match(/^ENV[ \t]+(?:.*\\\r?\n)*.*$/gm) ?? [];
  return directives.flatMap((directive) => {
    const body = directive
      .replace(/^ENV[ \t]+/, "")
      .replace(/\\\r?\n/g, " ")
      .trim();
    const firstToken = body.split(/\s+/, 1)[0] ?? "";
    const modernNames = body
      .split(/\s+/)
      .map((token) => token.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1])
      .filter((name): name is string => Boolean(name));
    const legacyName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(firstToken) ? [firstToken] : [];
    return firstToken.includes("=") ? modernNames : legacyName;
  });
}

describe("messaging plan final image environment contract", () => {
  it("recognizes modern and legacy Dockerfile ENV forms", () => {
    expect(
      dockerfileEnvNames(
        "ENV MODERN=value OTHER=second\nENV LEGACY value\nENV LEGACY_B64 eyJhIjoxfQ=\n",
      ),
    ).toEqual(["MODERN", "OTHER", "LEGACY", "LEGACY_B64"]);
  });

});
