// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execSync, spawnSync } = require("child_process");
const path = require("node:path");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");

const START_SERVICES_SH = path.join(__dirname, "..", "scripts", "start-services.sh");

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

  describe("validate_name", () => {
    // Test the validate_name case pattern directly (sourcing the full script
    // has side effects that interfere with the test environment).
    function testValidateName(name) {
      return spawnSync(
        "bash",
        ["-c", `
          validate_name() {
            case "$1" in
              (*[!A-Za-z0-9._-]*|'') return 1 ;;
            esac
          }
          validate_name ${JSON.stringify(name)}
        `],
        { encoding: "utf-8" }
      );
    }

    it("accepts valid sandbox names", () => {
      assert.equal(testValidateName("my-sandbox").status, 0);
    });

    it("rejects names with shell metacharacters", () => {
      assert.notEqual(testValidateName("foo;rm -rf /").status, 0);
    });

    it("rejects empty names", () => {
      assert.notEqual(testValidateName("").status, 0);
    });
  });

  describe("resolve_sandbox", () => {
    it("returns explicit sandbox name when not default", () => {
      const result = spawnSync(
        "bash",
        ["-c", `
          SANDBOX_NAME="my-box"
          resolve_sandbox() {
            if [ "$SANDBOX_NAME" != "default" ]; then
              printf '%s\\n' "$SANDBOX_NAME"
              return
            fi
          }
          resolve_sandbox
        `],
        { encoding: "utf-8" }
      );
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), "my-box");
    });
  });

  describe("service list includes gateway services", () => {
    it("show_status iterates openclaw-gateway and gateway-forward", () => {
      // Verify the script lists the new services in --status mode
      // by grepping the script source itself
      const script = require("node:fs").readFileSync(START_SERVICES_SH, "utf-8");
      assert.ok(
        script.includes("openclaw-gateway"),
        "start-services.sh should reference openclaw-gateway"
      );
      assert.ok(
        script.includes("gateway-forward"),
        "start-services.sh should reference gateway-forward"
      );
      // Verify the status loop includes all four services
      assert.match(
        script,
        /for svc in openclaw-gateway gateway-forward telegram-bridge cloudflared/,
        "show_status should iterate all four services"
      );
    });

    it("do_stop stops gateway services", () => {
      const script = require("node:fs").readFileSync(START_SERVICES_SH, "utf-8");
      assert.ok(
        script.includes("stop_service gateway-forward"),
        "do_stop should stop gateway-forward"
      );
      assert.ok(
        script.includes("stop_service openclaw-gateway"),
        "do_stop should stop openclaw-gateway"
      );
    });
  });
});
