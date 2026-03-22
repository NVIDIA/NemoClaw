// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const path = require("node:path");
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
  });

  describe("SANDBOX_NAME consistency across start/stop/status (#587)", () => {
    it("stop() passes SANDBOX_NAME via sandboxEnvPrefix", () => {
      const fs = require("fs");
      const src = fs.readFileSync(
        path.join(__dirname, "..", "bin", "nemoclaw.js"),
        "utf-8"
      );
      // stop() must use sandboxEnvPrefix so the PIDDIR matches start()
      const stopFn = src.match(/function stop\(\)[^}]*\}/s);
      assert.ok(stopFn, "stop() function must exist");
      assert.ok(
        stopFn[0].includes("sandboxEnvPrefix"),
        "stop() must call sandboxEnvPrefix() to resolve SANDBOX_NAME (fixes #587)"
      );
    });

    it("showStatus() passes SANDBOX_NAME via sandboxEnvPrefix", () => {
      const fs = require("fs");
      const src = fs.readFileSync(
        path.join(__dirname, "..", "bin", "nemoclaw.js"),
        "utf-8"
      );
      const statusFn = src.match(/function showStatus\(\)[^]*?^}/m);
      assert.ok(statusFn, "showStatus() function must exist");
      assert.ok(
        statusFn[0].includes("sandboxEnvPrefix"),
        "showStatus() must call sandboxEnvPrefix() to resolve SANDBOX_NAME (fixes #587)"
      );
    });

    it("sandboxEnvPrefix() is a shared helper used by start, stop, and status", () => {
      const fs = require("fs");
      const src = fs.readFileSync(
        path.join(__dirname, "..", "bin", "nemoclaw.js"),
        "utf-8"
      );
      const uses = (src.match(/sandboxEnvPrefix\(\)/g) || []).length;
      // At least 3 call sites: start(), stop(), showStatus()
      assert.ok(
        uses >= 3,
        `sandboxEnvPrefix() should be called at least 3 times (start/stop/status), found ${uses}`
      );
    });
  });
});
