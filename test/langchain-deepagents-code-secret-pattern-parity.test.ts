// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CONTEXT_PATTERNS,
  SECRET_BLOCK_PATTERNS,
  TOKEN_PREFIX_PATTERNS,
} from "../src/lib/security/secret-patterns.ts";
import {
  CANONICAL_SECRET_POSITIVE_VECTORS,
  type CanonicalSecretPatternGroup,
} from "./helpers/langchain-deepagents-code-secret-patterns.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const managedRuntimePath = path.join(
  repoRoot,
  "agents",
  "langchain-deepagents-code",
  "managed-dcode-runtime.py",
);
const observabilityPath = path.join(
  repoRoot,
  "agents",
  "langchain-deepagents-code",
  "nemoclaw_observability.py",
);

const canonicalPatterns: Record<CanonicalSecretPatternGroup, readonly RegExp[]> = {
  token: TOKEN_PREFIX_PATTERNS,
  context: CONTEXT_PATTERNS,
  block: SECRET_BLOCK_PATTERNS,
};

function fingerprint(patterns: readonly RegExp[]): string[] {
  return patterns.map((pattern) => `${pattern.source}::${pattern.flags}`);
}

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

describe("Deep Agents Code secret-pattern parity", () => {
  it("pins every canonical pattern source and flag for non-TypeScript mirrors (#6195)", () => {
    expect({
      token: fingerprint(TOKEN_PREFIX_PATTERNS),
      context: fingerprint(CONTEXT_PATTERNS),
      block: fingerprint(SECRET_BLOCK_PATTERNS),
    }).toEqual({
      token: [
        "nvapi-[A-Za-z0-9_-]{10,}::g",
        "nvcf-[A-Za-z0-9_-]{10,}::g",
        "ghp_[A-Za-z0-9_-]{10,}::g",
        "(?:github_pat_)[A-Za-z0-9_]{30,}::g",
        "sk-proj-[A-Za-z0-9_-]{10,}::g",
        "sk-ant-[A-Za-z0-9_-]{10,}::g",
        "sk-[A-Za-z0-9_-]{20,}::g",
        "(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}::g",
        "A(?:K|S)IA[A-Z0-9]{16}::g",
        "hf_[A-Za-z0-9]{10,}::g",
        "glpat-[A-Za-z0-9_-]{10,}::g",
        "gsk_[A-Za-z0-9]{10,}::g",
        "pypi-[A-Za-z0-9_-]{10,}::g",
        "\\bbot\\d{8,10}:[A-Za-z0-9_-]{35}\\b::g",
        "\\b\\d{8,10}:[A-Za-z0-9_-]{35}\\b::g",
        "\\b[A-Za-z0-9]{24}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,}\\b::g",
        "tvly-[A-Za-z0-9_-]{10,}::g",
        "lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*::g",
      ],
      context: [
        "(?<=Bearer\\s+)[A-Za-z0-9_.+/=-]{10,}::gi",
        "(?<=(?:_KEY|API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[=: ]['\"]?)[A-Za-z0-9_.+/=-]{10,}::gi",
      ],
      block: [
        "-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\\s\\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----::g",
      ],
    });
  });

  it("matches every shared positive vector with its designated canonical regex (#6195)", () => {
    for (const [group, patterns] of Object.entries(canonicalPatterns) as Array<
      [CanonicalSecretPatternGroup, readonly RegExp[]]
    >) {
      const coveredIndices = new Set(
        CANONICAL_SECRET_POSITIVE_VECTORS.filter((vector) => vector.patternGroup === group).map(
          (vector) => vector.patternIndex,
        ),
      );
      expect(coveredIndices, `${group} patterns must all have a positive vector`).toEqual(
        new Set(patterns.map((_pattern, index) => index)),
      );
    }

    for (const vector of CANONICAL_SECRET_POSITIVE_VECTORS) {
      const pattern = canonicalPatterns[vector.patternGroup][vector.patternIndex];
      expect(pattern, `${vector.label} designates an existing canonical regex`).toBeDefined();
      expect(matches(pattern as RegExp, vector.value), vector.label).toBe(true);
    }
  });

  it("detects every shared positive vector in the managed Python runtime (#6195)", () => {
    const probe = `
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("_nemoclaw_managed_parity", sys.argv[1])
if spec is None or spec.loader is None:
    raise RuntimeError("managed runtime module could not be loaded")
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)
values = json.load(sys.stdin)
json.dump([managed._contains_secret_shape(value) for value in values], sys.stdout)
`;
    const output = execFileSync("python3", ["-I", "-c", probe, managedRuntimePath], {
      encoding: "utf8",
      input: JSON.stringify(CANONICAL_SECRET_POSITIVE_VECTORS.map((vector) => vector.value)),
    });

    expect(JSON.parse(output)).toEqual(CANONICAL_SECRET_POSITIVE_VECTORS.map(() => true));
  });

  it("scrubs every shared positive vector in managed observability (#6452)", () => {
    const probe = `
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("_nemoclaw_observability_parity", sys.argv[1])
if spec is None or spec.loader is None:
    raise RuntimeError("observability module could not be loaded")
observability = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observability)
values = json.load(sys.stdin)
json.dump([observability._scrub_secret_values(value) for value in values], sys.stdout)
`;
    const values = CANONICAL_SECRET_POSITIVE_VECTORS.map((vector) => vector.value);
    const output = execFileSync("python3", ["-I", "-c", probe, observabilityPath], {
      encoding: "utf8",
      input: JSON.stringify(values),
    });
    const scrubbed = JSON.parse(output) as string[];

    for (const [index, value] of values.entries()) {
      expect(scrubbed[index], CANONICAL_SECRET_POSITIVE_VECTORS[index].label).toContain(
        "<redacted-secret>",
      );
      expect(scrubbed[index], CANONICAL_SECRET_POSITIVE_VECTORS[index].label).not.toContain(value);
    }
  });

  it("preserves benign near-misses in managed observability (#6452)", () => {
    const probe = `
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("_nemoclaw_observability_near_miss", sys.argv[1])
if spec is None or spec.loader is None:
    raise RuntimeError("observability module could not be loaded")
observability = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observability)
values = json.load(sys.stdin)
json.dump([observability._scrub_secret_values(value) for value in values], sys.stdout)
`;
    const values = [
      "sk-too-short",
      "Bearer short",
      "-----BEGIN PUBLIC KEY-----\\nnot-private\\n-----END PUBLIC KEY-----",
    ];
    const output = execFileSync("python3", ["-I", "-c", probe, observabilityPath], {
      encoding: "utf8",
      input: JSON.stringify(values),
    });

    expect(JSON.parse(output)).toEqual(values);
  });
});
