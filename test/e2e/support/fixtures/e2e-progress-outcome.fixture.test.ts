// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import { test } from "../../fixtures/e2e-test.ts";

const outcome = process.env.NEMOCLAW_E2E_PROGRESS_OUTCOME_FIXTURE;

test.runIf(outcome === "failed")(
  "records failed phase outcome",
  {
    meta: {
      e2ePhases: ["enter deterministic failure case", "raise deterministic assertion"],
    },
  },
  ({ expect, progress }) => {
    progress.phase("raise deterministic assertion");
    expect("actual").toBe("expected");
  },
);

test.runIf(outcome === "skipped")(
  "records skipped phase outcome",
  {
    meta: {
      e2ePhases: ["enter runtime skip case", "request runtime E2E skip"],
    },
  },
  ({ progress, skip }) => {
    progress.phase("request runtime E2E skip");
    skip("deterministic progress outcome fixture");
  },
);

test.runIf(outcome === "cleanup-failed")(
  "records cleanup failure phase outcome",
  {
    meta: {
      e2ePhases: ["enter cleanup failure case", "run failing E2E cleanup"],
    },
  },
  ({ cleanup, progress }) => {
    progress.phase("run failing E2E cleanup");
    cleanup.add("deterministic cleanup failure", async () => {
      await sleep(25);
      throw new Error("deterministic cleanup failure");
    });
  },
);

test.runIf(outcome === "soft-failed")(
  "records soft failure on its originating phase",
  {
    meta: {
      e2ePhases: ["record a soft assertion failure", "continue after the soft assertion"],
    },
  },
  ({ expect, progress }) => {
    expect.soft("actual").toBe("expected");
    progress.phase("continue after the soft assertion");
  },
);

test.runIf(outcome === "incomplete")(
  "rejects incomplete phase plan",
  {
    meta: {
      e2ePhases: ["enter incomplete phase case", "reach required final phase"],
    },
  },
  () => undefined,
);

test.runIf(outcome === "redacted-event")(
  "redacts progress identities and explicit events",
  {
    meta: {
      e2ePhases: ["prepare redacted progress event", "finish redacted progress event"],
    },
  },
  ({ expect, progress }) => {
    const secret = process.env.NEMOCLAW_E2E_PROGRESS_EVENT_SECRET;
    expect(secret, "redacted-event fixture secret is required").toBeTruthy();
    progress.event(`retry cleanup for ${secret}`);
    progress.phase("finish redacted progress event");
  },
);
