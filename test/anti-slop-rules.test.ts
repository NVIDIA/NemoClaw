// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { RuleTester } from "oxlint/plugins-dev";
import { describe, expect, it } from "vitest";

import { antiSlopRules } from "../oxlint.config.ts";
import antiSlopPlugin from "../tools/oxlint/anti-slop/index.ts";

const ruleCases = [
  {
    name: "no-chained-type-assertions",
    invalid: "const user = input as object as User;",
    valid: "const user = input as User;",
  },
  {
    name: "no-conditional-empty-object-spread",
    invalid: "const options = { ...(timeout !== undefined ? { timeout } : {}) };",
    valid: "const options = timeout !== undefined ? { timeout } : {};",
  },
  {
    name: "no-known-value-widening",
    invalid:
      "type Handler = () => void; const handlers: Record<string, Handler> = { start: () => {} };",
    valid:
      "type Handler = () => void; const handlers = { start: () => {} } satisfies Record<string, Handler>;",
  },
  {
    name: "no-module-mocking",
    invalid: "vi.mock('./user-store');",
    valid: "vi.spyOn(store, 'save');",
  },
  {
    name: "no-object-parameters",
    invalid: "function save(value: object) {}",
    valid: "function save(value: User) {}",
  },
  {
    name: "no-reflect-apply",
    invalid: "const value = Reflect.apply(operation, owner, args);",
    valid: "const value = operation(...args);",
  },
  {
    name: "no-reflect-get",
    invalid: "const value = Reflect.get(owner, key);",
    valid: "const value = owner[key];",
  },
  {
    name: "no-runtime-typeof",
    invalid: "if (typeof input === 'string') useName(input);",
    valid: "const parsed = parseInput(input); if (parsed.kind === 'name') useName(parsed.value);",
  },
  {
    name: "no-shape-in-symbol-names",
    invalid: "interface UserShape { id: string }",
    valid: "interface User { id: string }",
  },
  {
    name: "no-unknown-parameters",
    invalid: "function handle(input: unknown) {}",
    valid: "function handle(input: UserInput) {}",
  },
  {
    name: "no-unknown-returns",
    invalid: "function loadUser(): unknown { return input; }",
    valid: "function loadUser(): User { return user; }",
  },
  {
    name: "no-unknown-type-aliases",
    invalid: "type ExternalValue = unknown;",
    valid: "type ExternalValue = string | number;",
  },
  {
    name: "no-unsafe-dictionary-type",
    invalid: "type Metadata = Record<string, unknown>;",
    valid: "type Metadata = Record<string, string>;",
  },
  {
    name: "no-widen-then-assert",
    invalid:
      "const loaded: User = loadUser(); const stored: unknown = loaded; const user = stored as User;",
    valid: "const user = loadUser(); saveUser(user);",
  },
  {
    name: "require-safety-comment-for-type-assertion",
    invalid: "const userId = value as UserId;",
    valid:
      "// SAFETY: parseUserId validated the identifier before branding it.\nconst userId = value as UserId;",
  },
] as const;

describe("vendored anti-slop rules", () => {
  it("registers every configured anti-slop rule", () => {
    const configured = Object.keys(antiSlopRules)
      .map((name) => name.replace("anti-slop/", ""))
      .sort();
    const registered = Object.keys(antiSlopPlugin.rules).sort();

    expect(registered).toEqual(configured);
  });

  it.each(ruleCases)("rejects prohibited $name source and accepts its replacement", (testCase) => {
    const rule = antiSlopPlugin.rules[testCase.name];
    if (!rule) throw new Error(`Missing anti-slop rule: ${testCase.name}`);
    const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

    tester.run(`anti-slop/${testCase.name}`, rule, {
      invalid: [{ code: testCase.invalid, errors: 1 }],
      valid: [testCase.valid],
    });

    expect(rule).toBeDefined();
  });
});
