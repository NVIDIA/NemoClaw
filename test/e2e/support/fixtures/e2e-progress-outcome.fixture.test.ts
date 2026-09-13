// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { test } from "../../fixtures/e2e-test.ts";

const outcome = process.env.NEMOCLAW_E2E_PROGRESS_OUTCOME_FIXTURE;

test.runIf(outcome === "failed")("records failed phase outcome", ({ expect, progress }) => {
  progress.phase("enter deterministic failure case");

  progress.phase("raise deterministic assertion");
  expect("actual").toBe("expected");
});

test.runIf(outcome === "skipped")("records skipped phase outcome", ({ progress, skip }) => {
  progress.phase("enter runtime skip case");

  progress.phase("request runtime E2E skip");
  skip("deterministic progress outcome fixture");
});

test.runIf(outcome === "cleanup-failed")(
  "records cleanup failure phase outcome",
  ({ cleanup, progress }) => {
    progress.phase("enter cleanup failure case");

    progress.phase("run failing E2E cleanup");
    cleanup.add("deterministic cleanup failure", async () => {
      await sleep(25);
      throw new Error("deterministic cleanup failure");
    });
  },
);

test.runIf(outcome === "cleanup-stalled")(
  "stalls after cleanup starts",
  ({ cleanup, expect, progress }) => {
    progress.phase("enter stalled cleanup case");

    const timeoutReady = process.env.NEMOCLAW_E2E_PROGRESS_TIMEOUT_READY;
    expect(timeoutReady, "timeout-ready marker path is required").toBeTruthy();
    progress.phase("run stalled E2E cleanup");
    cleanup.add("deterministic stalled cleanup", async () => {
      fs.writeFileSync(timeoutReady!, "ready");
      await sleep(60_000);
    });
  },
);

test.runIf(outcome === "soft-failed")(
  "records soft failure on its originating phase",
  ({ expect, progress }) => {
    progress.phase("record a soft assertion failure");

    expect.soft("actual").toBe("expected");
    progress.phase("continue after the soft assertion");
  },
);

test.runIf(outcome === "incomplete")(
  "accepts a test without a final phase declaration",
  () => undefined,
);

test.runIf(outcome === "redacted-event")(
  "redacts progress identities and explicit events",
  ({ expect, progress }) => {
    progress.phase("prepare redacted progress event");

    const secret = process.env.NEMOCLAW_E2E_PROGRESS_EVENT_SECRET;
    expect(secret, "redacted-event fixture secret is required").toBeTruthy();
    progress.event(`retry cleanup for ${secret}`);
    progress.phase("finish redacted progress event");
  },
);
