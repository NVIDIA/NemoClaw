// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// PATH-shadowing tests for the Hermes recovery boundary guards. Extracted from
// runtime-hermes-secret-boundary-behavioural.test.ts so the trusted-python3
// resolution path has its own focused file and the behavioural file no longer
// grows past the test-monolith threshold. Other generated-shell behaviour
// tests stay in the behavioural file; pure shape assertions live in
// runtime-hermes-secret-boundary-shape.test.ts.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __testing, HERMES_SECRET_BOUNDARY_VALIDATOR_PATH } from "./hermes-recovery-boundary";

function writeStub(dir: string, name: string, body: string) {
  const stub = path.join(dir, name);
  fs.writeFileSync(stub, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return stub;
}

function removeTempDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

describe("Hermes secret-boundary guard — trusted-python3 PATH shadowing", () => {
  it("refuses recovery when no python3 exists at a trusted absolute path even if a PATH-shadowed python3 is present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-guard-shadow-"));
    const stubsDir = path.join(tmp, "bin");
    const validatorRoot = path.join(tmp, "usr-local-lib-nemoclaw");
    const recoveryLogPath = path.join(tmp, "gateway-recovery.log");
    fs.mkdirSync(stubsDir, { recursive: true });
    fs.mkdirSync(validatorRoot, { recursive: true });
    fs.writeFileSync(
      path.join(validatorRoot, "validate-hermes-env-secret-boundary.py"),
      "#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n",
    );
    writeStub(stubsDir, "python3", "exit 0");
    writeStub(stubsDir, "pkill", "exit 0");
    writeStub(stubsDir, "sleep", "exit 0");

    const validatorPath = path.join(validatorRoot, "validate-hermes-env-secret-boundary.py");
    const stubbed = __testing
      .buildHermesEnvFileBoundaryGuard()
      .replace(new RegExp(HERMES_SECRET_BOUNDARY_VALIDATOR_PATH, "g"), validatorPath)
      .replace(/\/tmp\/gateway-recovery\.log/g, recoveryLogPath)
      .replace(/\/usr\/local\/bin\/python3/g, path.join(tmp, "no-such-python3-a"))
      .replace(/\/usr\/bin\/python3/g, path.join(tmp, "no-such-python3-b"))
      .replace(/\/opt\/hermes\/\.venv\/bin\/python3/g, path.join(tmp, "no-such-python3-c"));
    const scriptPath = path.join(tmp, "guard.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -u",
        `export PATH=${JSON.stringify(stubsDir)}:/usr/bin:/bin`,
        stubbed,
        'printf "REACHED_LAUNCH\\n"',
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 10_000,
        env: { PATH: `${stubsDir}:/usr/bin:/bin`, HOME: tmp },
      });
      expect(result.status).toBe(127);
      expect(result.stdout).toContain("SECRET_BOUNDARY_PYTHON3_MISSING");
      expect(result.stdout).not.toContain("REACHED_LAUNCH");
      expect(result.stderr).toContain("no python3 at a trusted absolute path");
    } finally {
      removeTempDir(tmp);
    }
  });
});
