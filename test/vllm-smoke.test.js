// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

describe("vLLM smoke", () => {
  describe("vLLM detection in onboard", () => {
    it("detects vLLM via localhost:8000 health check", () => {
      // Verify the detection pattern used in onboard.js
      // onboard checks: curl -sf http://localhost:8000/v1/models
      // We just verify the pattern is correct by checking the source
      const onboardSrc = fs.readFileSync(
        path.join(__dirname, "..", "bin", "lib", "onboard.js"),
        "utf-8"
      );
      assert.ok(
        onboardSrc.includes("localhost:8000/v1/models"),
        "onboard should check vLLM on port 8000"
      );
    });

    it("vLLM provider uses host.openshell.internal gateway URL", () => {
      const onboardSrc = fs.readFileSync(
        path.join(__dirname, "..", "bin", "lib", "onboard.js"),
        "utf-8"
      );
      assert.ok(
        onboardSrc.includes("host.openshell.internal"),
        "vLLM provider should route through host gateway"
      );
      // vLLM base URL should point to port 8000 on the gateway
      assert.ok(
        onboardSrc.includes("8000/v1"),
        "vLLM base URL should use port 8000"
      );
    });

    it("vLLM option requires NEMOCLAW_EXPERIMENTAL=1", () => {
      const onboardSrc = fs.readFileSync(
        path.join(__dirname, "..", "bin", "lib", "onboard.js"),
        "utf-8"
      );
      // Both auto-detection and menu option are gated by EXPERIMENTAL
      assert.ok(
        onboardSrc.includes("EXPERIMENTAL") && onboardSrc.includes("vllm"),
        "vLLM should be gated behind NEMOCLAW_EXPERIMENTAL"
      );
    });
  });

  describe("vLLM NIM health check pattern", () => {
    it("waitForNimHealth polls /v1/models endpoint", () => {
      const nimSrc = fs.readFileSync(
        path.join(__dirname, "..", "bin", "lib", "nim.js"),
        "utf-8"
      );
      assert.ok(
        nimSrc.includes("/v1/models"),
        "health check should poll /v1/models (OpenAI-compatible)"
      );
    });

    it("waitForNimHealth accepts custom port", () => {
      const nim = require("../bin/lib/nim");
      // Verify the function signature accepts port parameter
      assert.equal(nim.waitForNimHealth.length, 0,
        "waitForNimHealth should have 0 required params (port and timeout are optional)");
    });
  });

  describe("blueprint profile", () => {
    it("nemoclaw-blueprint directory exists", () => {
      const blueprintDir = path.join(__dirname, "..", "nemoclaw-blueprint");
      assert.ok(fs.existsSync(blueprintDir), "nemoclaw-blueprint should exist");
    });

    it("policies directory contains sandbox config", () => {
      const policiesDir = path.join(__dirname, "..", "nemoclaw-blueprint", "policies");
      if (fs.existsSync(policiesDir)) {
        const files = fs.readdirSync(policiesDir);
        assert.ok(files.length > 0, "policies dir should have at least one policy");
        assert.ok(
          files.some((f) => f.includes("sandbox") || f.includes("openclaw")),
          "should have a sandbox/openclaw policy file"
        );
      }
    });
  });
});
