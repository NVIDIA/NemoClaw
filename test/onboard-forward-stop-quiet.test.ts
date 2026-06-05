// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, it } from "vitest";

const requireFromHere = createRequire(import.meta.url);

interface RunnerCall {
  args: string[];
  opts: { ignoreError?: boolean; suppressOutput?: boolean };
}

describe("onboard bestEffortForwardStop (#3971)", () => {
  it("calls forward stop with ignoreError and suppressOutput", () => {
    const distPath = path.join(import.meta.dirname, "..", "dist", "lib", "onboard", "forward-cleanup");
    const { bestEffortForwardStop } = requireFromHere(distPath) as {
      bestEffortForwardStop: (
        runner: (args: string[], opts: RunnerCall["opts"]) => unknown,
        port: string | number,
      ) => void;
    };

    const calls: RunnerCall[] = [];
    const stubRunner = (args: string[], opts: RunnerCall["opts"]) => {
      calls.push({ args, opts });
      return { status: 0, stdout: "", stderr: "" };
    };

    bestEffortForwardStop(stubRunner, 18789);

    assert.equal(calls.length, 1, `expected one runner call, got ${calls.length}`);
    assert.deepEqual(calls[0].args, ["forward", "stop", "18789"]);
    assert.equal(calls[0].opts.ignoreError, true);
    assert.equal(
      calls[0].opts.suppressOutput,
      true,
      "suppressOutput must be true so 'No active forward found' warnings stay off the user-visible stream",
    );
  });

  it("coerces numeric and string ports to string in argv", () => {
    const distPath = path.join(import.meta.dirname, "..", "dist", "lib", "onboard", "forward-cleanup");
    const { bestEffortForwardStop } = requireFromHere(distPath) as {
      bestEffortForwardStop: (
        runner: (args: string[], opts: RunnerCall["opts"]) => unknown,
        port: string | number,
      ) => void;
    };

    const calls: RunnerCall[] = [];
    const stubRunner = (args: string[], opts: RunnerCall["opts"]) => {
      calls.push({ args, opts });
      return { status: 0 };
    };

    bestEffortForwardStop(stubRunner, 65000);
    bestEffortForwardStop(stubRunner, "65001");

    assert.equal(calls.length, 2);
    assert.equal(calls[0].args[2], "65000");
    assert.equal(calls[1].args[2], "65001");
  });
});
