// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  formatHostPythonFailureMessage,
  MAX_PYTHON_EXCLUSIVE,
  MIN_PYTHON_VERSION,
  pickHostPython,
} from "../../../dist/lib/onboard/model-router-python";

function probeOk(version: readonly [number, number, number]) {
  return {
    exit: 0,
    stdout: JSON.stringify({ version: [...version], error: null }),
    stderr: "",
  };
}

function probeImportError(detail: string, version: readonly [number, number, number] = [3, 14, 5]) {
  return {
    exit: 1,
    stdout: JSON.stringify({ version: [...version], error: detail }),
    stderr: "",
  };
}

describe("pickHostPython", () => {
  it("prefers a healthy higher-version candidate over a healthy lower-version one", () => {
    const which = (cmd: string) => ({
      "python3.13": "/usr/bin/python3.13",
      "python3.12": "/usr/bin/python3.12",
      "python3.11": "/usr/bin/python3.11",
    })[cmd] ?? null;
    const probe = () => probeOk([3, 13, 2]);

    const result = pickHostPython({ which, probe, log: () => {}, env: {} });

    assert.equal(result.ok?.command, "python3.13");
    assert.equal(result.ok?.executable, "/usr/bin/python3.13");
    assert.deepEqual(result.ok?.version, [3, 13, 2]);
    assert.deepEqual(result.failures, []);
  });

  it("falls back when the top candidate fails the stdlib probe (#3781)", () => {
    const which = (cmd: string) => ({
      "python3.14": null,
      "python3.13": null,
      "python3.12": null,
      "python3.11": "/opt/homebrew/bin/python3.11",
      python3: "/opt/homebrew/bin/python3.14",
    })[cmd] ?? null;
    const probe = (executable: string) => {
      if (executable === "/opt/homebrew/bin/python3.14") {
        return probeImportError(
          "ImportError: dlopen(...pyexpat.cpython-314-darwin.so): Symbol not found: _XML_SetAllocTrackerActivationThreshold",
        );
      }
      return probeOk([3, 11, 8]);
    };

    const result = pickHostPython({ which, probe, log: () => {}, env: {} });

    assert.equal(result.ok?.command, "python3.11");
    assert.equal(result.ok?.executable, "/opt/homebrew/bin/python3.11");
    assert.deepEqual(result.ok?.version, [3, 11, 8]);
  });

  it("rejects a python whose version is below the supported floor", () => {
    const which = (cmd: string) => (cmd === "python3" ? "/usr/bin/python3" : null);
    const probe = () => probeOk([3, 8, 10]);

    const result = pickHostPython({ which, probe, log: () => {}, env: {} });

    assert.equal(result.ok, null);
    const reason = result.failures.find((f) => f.resolved === "/usr/bin/python3")?.reason ?? "";
    assert.match(reason, /below supported floor/);
    assert.match(reason, /3\.10/);
  });

  it("rejects a python whose version is at or above the exclusive ceiling", () => {
    const which = (cmd: string) => (cmd === "python3" ? "/opt/homebrew/bin/python3" : null);
    const probe = () => probeOk([3, 14, 5]);

    const result = pickHostPython({ which, probe, log: () => {}, env: {} });

    assert.equal(result.ok, null);
    const reason = result.failures.find((f) => f.resolved === "/opt/homebrew/bin/python3")?.reason ?? "";
    assert.match(reason, /above supported ceiling/);
    assert.match(reason, /3\.14/);
  });

  it("dedupes candidates that resolve to the same absolute path", () => {
    let probeCount = 0;
    const which = () => "/usr/bin/python3";
    const probe = () => {
      probeCount += 1;
      return probeOk([3, 12, 4]);
    };

    const result = pickHostPython({ which, probe, log: () => {}, env: {} });

    assert.equal(result.ok?.executable, "/usr/bin/python3");
    // Each candidate name resolves to the same absolute path, so probe runs only once.
    assert.equal(probeCount, 1);
  });

  it("honours NEMOCLAW_MODEL_ROUTER_PYTHON as the highest-priority candidate", () => {
    const which = (cmd: string) => ({
      "python3.13": "/usr/bin/python3.13",
    })[cmd] ?? null;
    const probe = (executable: string) => {
      if (executable === "/opt/custom/python3.12") return probeOk([3, 12, 6]);
      if (executable === "/usr/bin/python3.13") return probeOk([3, 13, 2]);
      return probeImportError("never picked");
    };

    const result = pickHostPython({
      which,
      probe,
      log: () => {},
      env: { NEMOCLAW_MODEL_ROUTER_PYTHON: "/opt/custom/python3.12" },
    });

    assert.equal(result.ok?.command, "/opt/custom/python3.12");
    assert.equal(result.ok?.executable, "/opt/custom/python3.12");
    assert.deepEqual(result.ok?.version, [3, 12, 6]);
  });

  it("returns ok=null with per-candidate failures when nothing qualifies", () => {
    const which = (cmd: string) => (cmd === "python3" ? "/opt/homebrew/bin/python3" : null);
    const probe = () => probeImportError("ImportError: missing pyexpat");

    const result = pickHostPython({ which, probe, log: () => {}, env: {} });

    assert.equal(result.ok, null);
    assert.ok(result.failures.length >= 1);
    const message = formatHostPythonFailureMessage(result.failures);
    assert.match(message, /No usable host Python interpreter/);
    assert.match(message, /ImportError: missing pyexpat/);
    assert.match(message, /NEMOCLAW_MODEL_ROUTER_PYTHON/);
  });
});

describe("supported version window", () => {
  it("aligns with Model Router pyproject requires-python >=3.10", () => {
    assert.deepEqual([...MIN_PYTHON_VERSION], [3, 10]);
  });

  it("excludes 3.14 to dodge the macOS Homebrew pyexpat regression in #3781", () => {
    assert.deepEqual([...MAX_PYTHON_EXCLUSIVE], [3, 14]);
  });
});
