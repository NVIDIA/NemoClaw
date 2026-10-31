// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function e2eAssertionBudget(
  expectCalls: number,
  referenceSha = "a".repeat(40),
  file = "test/e2e/live/example.test.ts",
): string {
  const metrics = {
    expectCalls,
    matcherAssertions: expectCalls,
    nodeAssertions: 0,
    namedAssertionHelpers: 0,
    failCalls: 0,
    throwGuards: 0,
    objectFieldAssertions: 0,
    assertionPoints: expectCalls,
    generatedProbeBlocks: 0,
    generatedProbeConditions: 0,
  };
  return JSON.stringify({
    $comment: "fixture",
    schemaVersion: 1,
    issue: 10934,
    epic: 10920,
    reference: {
      mainSha: referenceSha,
      currentMainCollectedTests: 1,
      epicMainSha: "b".repeat(40),
      epicCollectedTests: 95,
      epicDirectExpectCalls: 2184,
      epicLiveExpectCalls: 2677,
    },
    limits: {
      testFileCount: 1,
      liveFileCount: 1,
      direct: metrics,
      unique: metrics,
      fileMetricOrder: [
        "directExpectCalls",
        "directAssertionPoints",
        "transitiveExpectCalls",
        "transitiveAssertionPoints",
        "transitiveGeneratedProbeBlocks",
      ],
      files: {
        [file]: [expectCalls, expectCalls, expectCalls, expectCalls, 0],
      },
    },
  });
}
