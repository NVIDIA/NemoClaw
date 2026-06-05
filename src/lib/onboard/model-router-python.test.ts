// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

import {
  formatHostPythonFailureMessage,
  MAX_PYTHON_EXCLUSIVE,
  MIN_PYTHON_VERSION,
  OVERRIDE_ENV_VAR,
  pickHostPython,
  prepareModelRouterVenv,
} from "../../../dist/lib/onboard/model-router-python";

function probeOk(version: readonly [number, number, number]) {
  return {
    exit: 0,
    stdout: JSON.stringify({ version: [...version], error: null }),
    stderr: "",
  };
}

function probeImportError(detail: string, version: readonly [number, number, number] = [3, 13, 0]) {
  return {
    exit: 1,
    stdout: JSON.stringify({ version: [...version], error: detail }),
    stderr: "",
  };
}

function writeFakePython(filePath: string, version: readonly [number, number, number] = [3, 13, 0]) {
  fs.writeFileSync(
    filePath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "$1" = "-c" ]; then',
      `  printf '{"version": [${version.join(", ")}], "error": null}\\n'`,
      "  exit 0",
      "fi",
      'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
      '  mkdir -p "$3/bin"',
      '  printf "#!/usr/bin/env bash\\n" > "$3/bin/python"',
      '  chmod +x "$3/bin/python"',
      "  exit 0",
      "fi",
      "exit 99",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

describe("pickHostPython", () => {
  it("prefers a healthy higher-version candidate over a healthy lower-version one", () => {
    const which = (cmd: string) => ({
      "python3.13": "/usr/bin/python3.13",
      "python3.12": "/usr/bin/python3.12",
      "python3.11": "/usr/bin/python3.11",
      "python3.10": "/usr/bin/python3.13",
      python3: "/usr/bin/python3.13",
    })[cmd] ?? null;
    const probe = (executable: string) =>
      ({
        "/usr/bin/python3.13": probeOk([3, 13, 2]),
        "/usr/bin/python3.12": probeOk([3, 12, 7]),
        "/usr/bin/python3.11": probeOk([3, 11, 9]),
      })[executable] ?? probeImportError("never picked");

    const result = pickHostPython({ which, probe, log: () => {}, env: {} });

    assert.equal(result.ok?.candidate, "python3.13");
    assert.equal(result.ok?.executable, "/usr/bin/python3.13");
    assert.deepEqual(result.ok?.version, [3, 13, 2]);
    assert.deepEqual(result.failures, []);
    assert.equal(result.overrideRequested, false);
  });

  it("returns every healthy candidate in priority order so the caller can fall back on venv failure (#3786 Codex P2)", () => {
    const which = (cmd: string) => ({
      "python3.13": "/usr/bin/python3.13",
      "python3.12": "/usr/bin/python3.12",
      "python3.11": "/usr/bin/python3.11",
      "python3.10": null,
      python3: "/usr/bin/python3.13",
    })[cmd] ?? null;
    const probe = (executable: string) =>
      ({
        "/usr/bin/python3.13": probeOk([3, 13, 2]),
        "/usr/bin/python3.12": probeOk([3, 12, 7]),
        "/usr/bin/python3.11": probeOk([3, 11, 9]),
      })[executable] ?? probeImportError("never picked");

    const result = pickHostPython({ which, probe, log: () => {}, env: {} });

    assert.deepEqual(
      result.healthy.map((h) => h.candidate),
      ["python3.13", "python3.12", "python3.11"],
    );
    // python3 deduped because it resolves to the same path as python3.13.
    assert.equal(result.healthy.length, 3);
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

    assert.equal(result.ok?.candidate, "python3.11");
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

  it("treats NEMOCLAW_MODEL_ROUTER_PYTHON as a strict pin and does not fall back to PATH (#3786 Codex P3)", () => {
    const which = (cmd: string) => (cmd === "python3.12" ? "/usr/bin/python3.12" : null);
    const probe = (executable: string) => {
      if (executable === "/opt/custom/python3.10") {
        return probeImportError("ImportError: bogus override");
      }
      // Any unexpected probe (e.g. on the PATH python3.12) would mean we
      // wrongly fell back — return a healthy result so the assertion can
      // catch the regression.
      return probeOk([3, 12, 7]);
    };

    const result = pickHostPython({
      which,
      probe,
      log: () => {},
      env: { [OVERRIDE_ENV_VAR]: "/opt/custom/python3.10" },
    });

    assert.equal(result.ok, null);
    assert.equal(result.overrideRequested, true);
    assert.deepEqual(result.healthy, []);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].candidate, "/opt/custom/python3.10");
  });

  it("rejects a non-absolute NEMOCLAW_MODEL_ROUTER_PYTHON pin without resolving PATH", () => {
    let whichCalled = false;
    let probeCalled = false;
    const result = pickHostPython({
      which: () => {
        whichCalled = true;
        return "/usr/bin/python3.12";
      },
      probe: () => {
        probeCalled = true;
        return probeOk([3, 12, 7]);
      },
      log: () => {},
      env: { [OVERRIDE_ENV_VAR]: "python3.12" },
    });

    assert.equal(result.ok, null);
    assert.equal(result.overrideRequested, true);
    assert.deepEqual(result.healthy, []);
    assert.equal(whichCalled, false);
    assert.equal(probeCalled, false);
    assert.match(result.failures[0].reason, /absolute path/);
  });

  it("honours a healthy NEMOCLAW_MODEL_ROUTER_PYTHON override", () => {
    const which = () => null;
    const probe = (executable: string) =>
      executable === "/opt/custom/python3.12" ? probeOk([3, 12, 6]) : probeImportError("never picked");

    const result = pickHostPython({
      which,
      probe,
      log: () => {},
      env: { [OVERRIDE_ENV_VAR]: "/opt/custom/python3.12" },
    });

    assert.equal(result.ok?.candidate, "/opt/custom/python3.12");
    assert.equal(result.ok?.executable, "/opt/custom/python3.12");
    assert.deepEqual(result.ok?.version, [3, 12, 6]);
    assert.equal(result.overrideRequested, true);
  });

  it("returns ok=null with per-candidate failures when nothing qualifies", () => {
    const which = (cmd: string) => (cmd === "python3" ? "/opt/homebrew/bin/python3" : null);
    const probe = () => probeImportError("ImportError: missing pyexpat");

    const result = pickHostPython({ which, probe, log: () => {}, env: {} });

    assert.equal(result.ok, null);
    assert.deepEqual(result.healthy, []);
    assert.ok(result.failures.length >= 1);
    const message = formatHostPythonFailureMessage(result.failures, {
      overrideRequested: result.overrideRequested,
    });
    assert.match(message, /No usable host Python interpreter/);
    assert.match(message, /ImportError: missing pyexpat/);
    assert.match(message, new RegExp(OVERRIDE_ENV_VAR));
  });

  it("tailors the failure message when the override pin is the only candidate that failed", () => {
    const which = () => null;
    const probe = () => probeImportError("ImportError: cannot import name 'foo'");

    const result = pickHostPython({
      which,
      probe,
      log: () => {},
      env: { [OVERRIDE_ENV_VAR]: "/opt/custom/python3.10" },
    });

    const message = formatHostPythonFailureMessage(result.failures, {
      overrideRequested: result.overrideRequested,
    });
    assert.match(message, new RegExp(`${OVERRIDE_ENV_VAR} pins`));
    assert.match(message, /not usable/);
    assert.match(message, /Unset/);
  });

  it("surfaces spawn errors when an absolute override path does not exist", () => {
    const result = pickHostPython({
      log: () => {},
      env: { [OVERRIDE_ENV_VAR]: "/tmp/nemoclaw-model-router-python-does-not-exist" },
    });

    assert.equal(result.ok, null);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].reason, /ENOENT|spawn/i);
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

describe("prepareModelRouterVenv", () => {
  it("refuses to replace an existing unowned venv directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-router-python-owned-"));
    const oldPath = process.env.PATH;
    const oldOverride = process.env[OVERRIDE_ENV_VAR];
    try {
      const fakeBin = path.join(tmpDir, "bin");
      const venvDir = path.join(tmpDir, "existing-dir");
      const sentinel = path.join(venvDir, "do-not-delete.txt");
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.mkdirSync(venvDir, { recursive: true });
      fs.writeFileSync(sentinel, "important");
      writeFakePython(path.join(fakeBin, "python3.13"));

      process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
      delete process.env[OVERRIDE_ENV_VAR];

      assert.throws(
        () => prepareModelRouterVenv({ venvDir, log: () => {} }),
        /refusing to replace existing Model Router virtual environment directory/,
      );
      assert.equal(fs.readFileSync(sentinel, "utf-8"), "important");
    } finally {
      process.env.PATH = oldPath;
      if (oldOverride === undefined) delete process.env[OVERRIDE_ENV_VAR];
      else process.env[OVERRIDE_ENV_VAR] = oldOverride;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
