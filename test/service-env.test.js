// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");

describe("service environment", () => {
  describe("resolveOpenshell logic", () => {
    it("returns command -v result when absolute path", () => {
      assert.equal(
        resolveOpenshell({ commandVResult: "/usr/bin/openshell" }),
        "/usr/bin/openshell"
      );
    });

    it("rejects non-absolute command -v result (alias)", () => {
      assert.equal(
        resolveOpenshell({ commandVResult: "openshell", checkExecutable: () => false }),
        null
      );
    });

    it("rejects alias definition from command -v", () => {
      assert.equal(
        resolveOpenshell({ commandVResult: "alias openshell='echo pwned'", checkExecutable: () => false }),
        null
      );
    });

    it("falls back to ~/.local/bin when command -v fails", () => {
      assert.equal(
        resolveOpenshell({
          commandVResult: null,
          checkExecutable: (p) => p === "/fakehome/.local/bin/openshell",
          home: "/fakehome",
        }),
        "/fakehome/.local/bin/openshell"
      );
    });

    it("falls back to /usr/local/bin", () => {
      assert.equal(
        resolveOpenshell({
          commandVResult: null,
          checkExecutable: (p) => p === "/usr/local/bin/openshell",
        }),
        "/usr/local/bin/openshell"
      );
    });

    it("falls back to /usr/bin", () => {
      assert.equal(
        resolveOpenshell({
          commandVResult: null,
          checkExecutable: (p) => p === "/usr/bin/openshell",
        }),
        "/usr/bin/openshell"
      );
    });

    it("prefers ~/.local/bin over /usr/local/bin", () => {
      assert.equal(
        resolveOpenshell({
          commandVResult: null,
          checkExecutable: (p) => p === "/fakehome/.local/bin/openshell" || p === "/usr/local/bin/openshell",
          home: "/fakehome",
        }),
        "/fakehome/.local/bin/openshell"
      );
    });

    it("returns null when openshell not found anywhere", () => {
      assert.equal(
        resolveOpenshell({
          commandVResult: null,
          checkExecutable: () => false,
        }),
        null
      );
    });
  });

  describe("SANDBOX_NAME defaulting", () => {
    it("start-services.sh preserves existing SANDBOX_NAME", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "", SANDBOX_NAME: "my-box" },
        }
      ).trim();
      assert.equal(result, "my-box");
    });

    it("start-services.sh uses NEMOCLAW_SANDBOX over SANDBOX_NAME", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "from-env", SANDBOX_NAME: "old" },
        }
      ).trim();
      assert.equal(result, "from-env");
    });

    it("start-services.sh falls back to default when both unset", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "", SANDBOX_NAME: "" },
        }
      ).trim();
      assert.equal(result, "default");
    });

    it("start-services.sh restores the forward for headless nullclaw sandboxes", () => {
      const repoRoot = path.join(__dirname, "..");
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-service-home-"));
      const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-service-bin-"));
      const logPath = path.join(tmpHome, "openshell.log");
      const registryDir = path.join(tmpHome, ".nemoclaw");
      const registryPath = path.join(registryDir, "sandboxes.json");
      const openshellPath = path.join(tmpBin, "openshell");

      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(registryPath, JSON.stringify({
        sandboxes: {
          headless: {
            name: "headless",
            runtime: "nullclaw",
            surface: "none",
            forwardPort: 3000,
          },
        },
        defaultSandbox: "headless",
      }));
      fs.writeFileSync(
        openshellPath,
        `#!/bin/sh
echo "$@" >> ${JSON.stringify(logPath)}
if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then
  echo "headless Ready"
fi
`,
        { mode: 0o755 }
      );

      execSync(`bash "${path.join(repoRoot, "scripts", "start-services.sh")}" --sandbox headless`, {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          PATH: `${tmpBin}:${process.env.PATH}`,
        },
      });

      const log = fs.readFileSync(logPath, "utf-8");
      assert.match(log, /forward start --background 3000 headless/);
    });
  });
});
