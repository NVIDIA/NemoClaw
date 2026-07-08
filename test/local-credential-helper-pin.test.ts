// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  extractCredentialPattern,
  extractEmbeddedFormDigest,
  extractProcessControlRules,
  extractStarterPrompt,
  extractStringSet,
} from "../scripts/checks/local-credential-helper-pin";

const FUNCTION_NAME = "isBlocked";
const SET_NAME = "BLOCKED_NAMES";
const VALID_ATOMS = [
  `${SET_NAME}.has(name)`,
  'name.startsWith("BASH_FUNC_")',
  'name.startsWith("LD_")',
  'name.startsWith("DYLD_")',
  'name === "GIT_CONFIG"',
  'name.startsWith("GIT_CONFIG_")',
  'name.startsWith("GIT_TRACE")',
];
const EXPECTED_RULES = [
  "exact:GIT_CONFIG",
  "literal-set",
  "prefix:BASH_FUNC_",
  "prefix:DYLD_",
  "prefix:GIT_CONFIG_",
  "prefix:GIT_TRACE",
  "prefix:LD_",
];

function predicateSource(expression: string): string {
  return `function ${FUNCTION_NAME}(name) {\n  return ${expression};\n}`;
}

function extractRules(source: string): string[] {
  return extractProcessControlRules(source, FUNCTION_NAME, SET_NAME, "fixture.ts");
}

describe("local credential helper pin predicate parity", () => {
  it("extracts every active process-control rule independent of OR order (#5048)", () => {
    expect(extractRules(predicateSource(VALID_ATOMS.join(" || ")))).toEqual(EXPECTED_RULES);
    expect(extractRules(predicateSource([...VALID_ATOMS].reverse().join(" || ")))).toEqual(
      EXPECTED_RULES,
    );
  });

  it.each([
    { atom: VALID_ATOMS[1], label: "BASH_FUNC_ prefix" },
    { atom: VALID_ATOMS[2], label: "LD_ prefix" },
    { atom: VALID_ATOMS[3], label: "DYLD_ prefix" },
    { atom: VALID_ATOMS[4], label: "exact GIT_CONFIG name" },
    { atom: VALID_ATOMS[5], label: "GIT_CONFIG_ prefix" },
    { atom: VALID_ATOMS[6], label: "GIT_TRACE prefix" },
  ])("detects removal of the $label (#5048)", ({ atom }) => {
    const mutated = VALID_ATOMS.filter((candidate) => candidate !== atom).join(" || ");

    expect(extractRules(predicateSource(mutated))).not.toEqual(EXPECTED_RULES);
  });

  it("distinguishes an exact-name rule from a broader prefix rule (#5048)", () => {
    const mutated = VALID_ATOMS.map((atom) =>
      atom === 'name === "GIT_CONFIG"' ? 'name.startsWith("GIT_CONFIG")' : atom,
    ).join(" || ");

    expect(extractRules(predicateSource(mutated))).not.toEqual(EXPECTED_RULES);
  });

  it("rejects rule-shaped statements after an early return (#5048)", () => {
    const unreachableRules = VALID_ATOMS.slice(1)
      .map((atom) => `${atom};`)
      .join("\n  ");
    const source = `function ${FUNCTION_NAME}(name) {\n  return ${VALID_ATOMS[0]};\n  ${unreachableRules}\n}`;

    expect(() => extractRules(source)).toThrow("must contain exactly one return expression");
  });

  it.each([
    {
      decoy: `/* ${predicateSource(VALID_ATOMS.join(" || "))} */`,
      label: "block-commented function",
    },
    {
      decoy: `const decoy = ${JSON.stringify(predicateSource(VALID_ATOMS.join(" || ")))};`,
      label: "string-embedded function",
    },
  ])("ignores a $label before the executable predicate (#5048)", ({ decoy }) => {
    const livePredicate = predicateSource(VALID_ATOMS[0]);

    expect(extractRules(`${decoy}\n${livePredicate}`)).toEqual(["literal-set"]);
  });

  it.each([
    {
      label: "async declaration",
      source: predicateSource(VALID_ATOMS.join(" || ")).replace("function", "async function"),
    },
    {
      label: "generator declaration",
      source: predicateSource(VALID_ATOMS.join(" || ")).replace("function ", "function* "),
    },
    {
      label: "wrong parameter name",
      source: predicateSource(VALID_ATOMS.join(" || ")).replace("(name)", "(other)"),
    },
    {
      label: "default parameter",
      source: predicateSource(VALID_ATOMS.join(" || ")).replace("(name)", '(name = "")'),
    },
    {
      label: "rest parameter",
      source: predicateSource(VALID_ATOMS.join(" || ")).replace("(name)", "(...name)"),
    },
  ])("rejects a $label (#5048)", ({ source }) => {
    expect(() => extractRules(source)).toThrow("must be a synchronous one-argument predicate");
  });

  it.each([
    {
      decoy: "/* const CREDENTIAL_SHAPED_NAME_PATTERN = /old/i; */",
      label: "block-commented pattern",
    },
    {
      decoy: 'const decoy = "const CREDENTIAL_SHAPED_NAME_PATTERN = /old/i;";',
      label: "string-embedded pattern",
    },
  ])("ignores a $label before the executable credential pattern (#5048)", ({ decoy }) => {
    const source = `${decoy}\nconst CREDENTIAL_SHAPED_NAME_PATTERN = /current_[A-Z]+/i;`;

    expect(extractCredentialPattern(source, "fixture.ts")).toBe("/current_[A-Z]+/i");
  });

  it.each([
    {
      decoy: '/* const BLOCKED_NAMES = new Set(["OLD"]); */',
      label: "block-commented set",
    },
    {
      decoy: `'const BLOCKED_NAMES = new Set(["OLD"]);';`,
      label: "string-embedded set",
    },
  ])("ignores a $label before the executable process-control set (#5048)", ({ decoy }) => {
    const source = `${decoy}\nconst BLOCKED_NAMES = new Set(["CURRENT"]);`;

    expect(extractStringSet(source, SET_NAME, "fixture.ts")).toEqual(["CURRENT"]);
  });

  it("ignores commented-out entries inside the executable process-control set (#5048)", () => {
    const source = 'const BLOCKED_NAMES = new Set([/* "OLD", */ "CURRENT"]);';

    expect(extractStringSet(source, SET_NAME, "fixture.ts")).toEqual(["CURRENT"]);
  });

  it.each([
    {
      decoy: `/* const EXPECTED_LOCAL_CREDENTIAL_FORM_SHA256 = "${"b".repeat(64)}"; */`,
      label: "block-commented digest",
    },
    {
      decoy: `const decoy = ${JSON.stringify(
        `const EXPECTED_LOCAL_CREDENTIAL_FORM_SHA256 = "${"b".repeat(64)}";`,
      )};`,
      label: "string-embedded digest",
    },
  ])("ignores a $label before the executable form digest (#5048)", ({ decoy }) => {
    const currentDigest = "a".repeat(64);
    const source = `${decoy}\nconst EXPECTED_LOCAL_CREDENTIAL_FORM_SHA256 = "${currentDigest}";`;

    expect(extractEmbeddedFormDigest(source, "fixture.ts")).toBe(currentDigest);
  });

  it.each([
    {
      decoy: "/* export const STARTER_PROMPT = `stale prompt`; */",
      label: "block-commented prompt",
    },
    {
      decoy: `const decoy = ${JSON.stringify("export const STARTER_PROMPT = `stale prompt`;")};`,
      label: "string-embedded prompt",
    },
  ])("ignores a $label before the executable starter prompt (#5048)", ({ decoy }) => {
    const source = `${decoy}\nexport const STARTER_PROMPT = \`current prompt\`;`;

    expect(extractStarterPrompt(source, "fixture.tsx")).toBe("current prompt");
  });
});
