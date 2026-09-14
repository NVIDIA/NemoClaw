// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock-acquisition";
import {
  currentHermesPortableStartupOperation,
  withHermesPortableStartupOperation,
} from "./hermes-portable-startup-operation";

const env = {
  NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
  NEMOCLAW_EXPERIMENTAL_PORTABLE_STARTUP_REUSE: "1",
};

describe("Portable startup evidence lifetime", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-startup-proof-"));
  });
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  it("retains one scope across nested startup and probe work only while locked (#11574)", async () => {
    const retained = await withMcpLifecycleLock(
      "alpha",
      () =>
        withHermesPortableStartupOperation(
          "alpha",
          stateDir,
          async () => {
            const first = currentHermesPortableStartupOperation("alpha");
            expect(first).toBeDefined();
            expect(currentHermesPortableStartupOperation("beta")).toBeUndefined();
            await withHermesPortableStartupOperation(
              "alpha",
              stateDir,
              () => {
                expect(currentHermesPortableStartupOperation("alpha")).toBe(first);
              },
              env,
            );
            return first;
          },
          env,
        ),
      { stateDir },
    );
    expect(retained?.current()).toBe(false);
    expect(currentHermesPortableStartupOperation("alpha")).toBeUndefined();
  });

  it.each([
    {},
    { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
    {
      NEMOCLAW_EXPERIMENTAL_PORTABLE_STARTUP_REUSE: "1",
    },
  ])("keeps ordinary calls on full verification with %j (#11574)", async (environment) => {
    await withMcpLifecycleLock(
      "alpha",
      () =>
        withHermesPortableStartupOperation(
          "alpha",
          stateDir,
          () => {
            expect(currentHermesPortableStartupOperation("alpha")).toBeUndefined();
          },
          environment,
        ),
      { stateDir },
    );
  });

  it.each([60_000, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "permanently expires evidence at invalid or exhausted time %s (#11574)",
    async (elapsed) => {
      let now = 100;
      await withMcpLifecycleLock(
        "alpha",
        () =>
          withHermesPortableStartupOperation(
            "alpha",
            stateDir,
            () => {
              expect(currentHermesPortableStartupOperation("alpha")).toBeDefined();
              now = 100 + elapsed;
              expect(currentHermesPortableStartupOperation("alpha")).toBeUndefined();
              now = 101;
              expect(currentHermesPortableStartupOperation("alpha")).toBeUndefined();
            },
            env,
            () => now,
          ),
        { stateDir },
      );
    },
  );

  it("cannot create reusable evidence without the matching lifecycle lock (#11574)", async () => {
    await withHermesPortableStartupOperation(
      "alpha",
      stateDir,
      () => {
        expect(currentHermesPortableStartupOperation("alpha")).toBeUndefined();
      },
      env,
    );
  });
});
