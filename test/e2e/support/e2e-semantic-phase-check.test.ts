// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  scanLiveSourceGraph,
  validateCollectedSemanticPhaseModule,
  validateTestScopedPhaseCalls,
} from "../../../tools/e2e/check-semantic-phases.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const INVALID_SOURCE_FIXTURE = path.join(
  REPO_ROOT,
  "test/e2e/support/fixtures/semantic-phase-invalid.fixture.ts",
);

describe("semantic E2E phase checker", () => {
  test("rejects missing metadata and invalid phase transitions from a collected module", () => {
    const failures = validateCollectedSemanticPhaseModule({
      relativeModuleId: "test/e2e/live/invalid-semantic-phase.test.ts",
      errors: [],
      tests: [
        { fullName: "missing semantic phase metadata" },
        {
          fullName: "invalid semantic phase transitions",
          phases: ["prepare fixture behavior", "exercise fixture behavior"],
        },
      ],
      source: scanLiveSourceGraph(INVALID_SOURCE_FIXTURE),
    });

    expect(failures).toHaveLength(3);
    expect(failures).toEqual(
      expect.arrayContaining([
        "test/e2e/live/invalid-semantic-phase.test.ts > missing semantic phase metadata: missing e2ePhases metadata",
        expect.stringMatching(/semantic phase transitions must use literals/u),
        expect.stringMatching(/undeclared semantic phase: undeclared fixture behavior/u),
      ]),
    );
  });

  test("accepts only the exact bootstrap forwarding alias", () => {
    const forwardingModule = {
      relativeModuleId: "test/e2e/live/bootstrap-install-smoke.test.ts",
      errors: [],
      tests: [],
      source: {
        importsDirectTest: false,
        importsSharedTest: false,
        phaseCalls: [],
        testPhaseBodies: [],
      },
    };

    expect(
      validateCollectedSemanticPhaseModule({
        ...forwardingModule,
        source: {
          ...forwardingModule.source,
          forwardedTestModules: ["test/e2e/live/launchable-smoke.test.ts"],
        },
      }),
    ).toEqual([]);
    const expectedFailure =
      "test/e2e/live/bootstrap-install-smoke.test.ts: forwarding module must import exactly test/e2e/live/launchable-smoke.test.ts";
    for (const forwardedTestModules of [
      [],
      ["test/e2e/live/other.test.ts"],
      ["test/e2e/live/launchable-smoke.test.ts", "test/e2e/live/other.test.ts"],
    ]) {
      expect(
        validateCollectedSemanticPhaseModule({
          ...forwardingModule,
          source: { ...forwardingModule.source, forwardedTestModules },
        }),
      ).toEqual([expectedFailure]);
    }
  });

  test("rejects phase transitions that belong to sibling tests", () => {
    const failures = validateTestScopedPhaseCalls(
      [
        { name: "GitHub download", phases: ["prepare GitHub", "download with GitHub"] },
        { name: "curl fallback", phases: ["prepare curl", "download with curl"] },
      ],
      [
        {
          file: "test/e2e/live/example.test.ts",
          line: 10,
          phaseCalls: [
            { file: "test/e2e/live/example.test.ts", line: 12, label: "download with curl" },
          ],
        },
        {
          file: "test/e2e/live/example.test.ts",
          line: 20,
          phaseCalls: [
            { file: "test/e2e/live/example.test.ts", line: 22, label: "download with GitHub" },
          ],
        },
      ],
    );

    expect(failures).toEqual([
      "test/e2e/live/example.test.ts:12: semantic phase is not declared by its test (GitHub download): download with curl",
      "test/e2e/live/example.test.ts:10: semantic phase is never entered by its test (GitHub download): download with GitHub",
      "test/e2e/live/example.test.ts:22: semantic phase is not declared by its test (curl fallback): download with GitHub",
      "test/e2e/live/example.test.ts:20: semantic phase is never entered by its test (curl fallback): download with curl",
    ]);
  });

  test("rejects a same-plan sibling that omits its final phase", () => {
    const phases = ["prepare shared fixture", "verify shared fixture"] as const;
    const failures = validateCollectedSemanticPhaseModule({
      relativeModuleId: "test/e2e/live/same-plan-siblings.test.ts",
      errors: [],
      tests: [
        { fullName: "complete sibling", phases },
        { fullName: "incomplete sibling", phases },
      ],
      source: {
        importsDirectTest: false,
        importsSharedTest: true,
        phaseCalls: [
          {
            file: "test/e2e/live/same-plan-siblings.test.ts",
            line: 12,
            label: "verify shared fixture",
          },
        ],
        testPhaseBodies: [
          {
            file: "test/e2e/live/same-plan-siblings.test.ts",
            line: 10,
            phaseCalls: [
              {
                file: "test/e2e/live/same-plan-siblings.test.ts",
                line: 12,
                label: "verify shared fixture",
              },
            ],
          },
          {
            file: "test/e2e/live/same-plan-siblings.test.ts",
            line: 20,
            phaseCalls: [],
          },
        ],
      },
    });

    expect(failures).toEqual([
      "test/e2e/live/same-plan-siblings.test.ts:20: semantic phase is never entered by its test (incomplete sibling): verify shared fixture",
    ]);
  });

  test("validates expanded same-plan registrations and ignores unconditional skips", () => {
    const phases = ["prepare shared fixture", "verify shared fixture"] as const;
    const failures = validateCollectedSemanticPhaseModule({
      relativeModuleId: "test/e2e/live/expanded-same-plan.test.ts",
      errors: [],
      tests: [
        { fullName: "skipped case", phases },
        { fullName: "expanded case one", phases },
        { fullName: "expanded case two", phases },
      ],
      source: {
        importsDirectTest: false,
        importsSharedTest: true,
        phaseCalls: [
          {
            file: "test/e2e/live/expanded-same-plan.test.ts",
            line: 22,
            label: "verify shared fixture",
          },
        ],
        testPhaseBodies: [
          {
            file: "test/e2e/live/expanded-same-plan.test.ts",
            line: 10,
            phaseCalls: [],
            skipped: true,
          },
          {
            file: "test/e2e/live/expanded-same-plan.test.ts",
            line: 20,
            phaseCalls: [
              {
                file: "test/e2e/live/expanded-same-plan.test.ts",
                line: 22,
                label: "verify shared fixture",
              },
            ],
          },
        ],
      },
    });

    expect(failures).toEqual([]);
  });

  test("accepts transitions declared by their own tests", () => {
    expect(
      validateTestScopedPhaseCalls(
        [
          { name: "GitHub download", phases: ["prepare GitHub", "download with GitHub"] },
          { name: "curl fallback", phases: ["prepare curl", "download with curl"] },
        ],
        [
          {
            file: "test/e2e/live/example.test.ts",
            line: 10,
            phaseCalls: [
              { file: "test/e2e/live/example.test.ts", line: 12, label: "download with GitHub" },
            ],
          },
          {
            file: "test/e2e/live/example.test.ts",
            line: 20,
            phaseCalls: [
              { file: "test/e2e/live/example.test.ts", line: 22, label: "download with curl" },
            ],
          },
        ],
      ),
    ).toEqual([]);
  });
});
