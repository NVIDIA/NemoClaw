// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

describe("service environment", () => {
  describe("resolveOpenshell logic", () => {
    // Extract and test the resolution algorithm without requiring openshell installed

    function resolveOpenshellTestable(opts = {}) {
      const commandVResult = opts.commandVResult; // string or null (throws)
      const existingPaths = opts.existingPaths || [];
      const home = opts.home || "/fakehome";

      // Step 1: command -v result
      if (commandVResult && commandVResult.startsWith("/")) {
        return commandVResult;
      }

      // Step 2: fallback candidates
      const candidates = [
        `${home}/.local/bin/openshell`,
        "/usr/local/bin/openshell",
        "/usr/bin/openshell",
      ];
      for (const p of candidates) {
        if (existingPaths.includes(p)) return p;
      }

      return null; // not found
    }

    it("returns command -v result when absolute path", () => {
      assert.equal(
        resolveOpenshellTestable({ commandVResult: "/usr/bin/openshell" }),
        "/usr/bin/openshell"
      );
    });

    it("rejects non-absolute command -v result (alias)", () => {
      assert.equal(
        resolveOpenshellTestable({ commandVResult: "openshell" }),
        null
      );
    });

    it("rejects alias definition from command -v", () => {
      assert.equal(
        resolveOpenshellTestable({ commandVResult: "alias openshell='echo pwned'" }),
        null
      );
    });

    it("falls back to ~/.local/bin when command -v fails", () => {
      assert.equal(
        resolveOpenshellTestable({
          commandVResult: null,
          existingPaths: ["/fakehome/.local/bin/openshell"],
          home: "/fakehome",
        }),
        "/fakehome/.local/bin/openshell"
      );
    });

    it("falls back to /usr/local/bin", () => {
      assert.equal(
        resolveOpenshellTestable({
          commandVResult: null,
          existingPaths: ["/usr/local/bin/openshell"],
        }),
        "/usr/local/bin/openshell"
      );
    });

    it("falls back to /usr/bin", () => {
      assert.equal(
        resolveOpenshellTestable({
          commandVResult: null,
          existingPaths: ["/usr/bin/openshell"],
        }),
        "/usr/bin/openshell"
      );
    });

    it("prefers ~/.local/bin over /usr/local/bin", () => {
      assert.equal(
        resolveOpenshellTestable({
          commandVResult: null,
          existingPaths: ["/fakehome/.local/bin/openshell", "/usr/local/bin/openshell"],
          home: "/fakehome",
        }),
        "/fakehome/.local/bin/openshell"
      );
    });

    it("returns null when openshell not found anywhere", () => {
      assert.equal(
        resolveOpenshellTestable({
          commandVResult: null,
          existingPaths: [],
        }),
        null
      );
    });
  });

  describe("SANDBOX_NAME defaulting", () => {
    it("start-services.sh preserves existing SANDBOX_NAME", () => {
      // Verify the bash variable expansion logic:
      // SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"
      const result = execSync(
        'SANDBOX_NAME=my-box bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}" && echo $SANDBOX_NAME\'',
        { encoding: "utf-8" }
      ).trim();
      assert.equal(result, "my-box");
    });

    it("start-services.sh uses NEMOCLAW_SANDBOX over SANDBOX_NAME", () => {
      const result = execSync(
        'NEMOCLAW_SANDBOX=from-env SANDBOX_NAME=old bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}" && echo $SANDBOX_NAME\'',
        { encoding: "utf-8" }
      ).trim();
      assert.equal(result, "from-env");
    });

    it("start-services.sh falls back to default when both unset", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}" && echo $SANDBOX_NAME\'',
        { encoding: "utf-8" }
      ).trim();
      assert.equal(result, "default");
    });
  });
});
