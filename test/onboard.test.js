// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildSandboxConfigSyncScript, parseDashboardUrlFromOutput } = require("../bin/lib/onboard");

describe("onboard helpers", () => {
  it("builds a sandbox sync script that writes config and updates the selected model", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      onboardedAt: "2026-03-18T12:00:00.000Z",
    });

    assert.match(script, /cat > ~\/\.nemoclaw\/config\.json/);
    assert.match(script, /"model": "nemotron-3-nano:30b"/);
    assert.match(script, /"credentialEnv": "OPENAI_API_KEY"/);
    assert.match(script, /openclaw models set 'inference\/nemotron-3-nano:30b'/);
    assert.match(script, /cfg\.setdefault\('agents', \{\}\)\.setdefault\('defaults', \{\}\)\.setdefault\('model', \{\}\)\['primary'\]/);
    assert.match(script, /providers_cfg\["inference"\]/);
    assert.match(script, /json\.loads\("\{\\\"baseUrl\\\":\\\"https:\/\/inference\.local\/v1\\\",\\\"apiKey\\\":\\\"unused\\\"/);
    assert.match(script, /inference\/nemotron-3-nano:30b/);
    assert.match(script, /^exit$/m);
  });

  describe("parseDashboardUrlFromOutput", () => {
    it("returns URL with token when output contains http URL with #token=", () => {
      const out = "some text\nhttp://127.0.0.1:18789/#token=961dc4bc7ae8237e6835f45863ee8da482aaec0efa9766f1\n";
      assert.equal(
        parseDashboardUrlFromOutput(out),
        "http://localhost:18789/#token=961dc4bc7ae8237e6835f45863ee8da482aaec0efa9766f1"
      );
    });

    it("normalizes 127.0.0.1 to localhost", () => {
      const out = "http://127.0.0.1:18789/#token=abc123";
      assert.equal(parseDashboardUrlFromOutput(out), "http://localhost:18789/#token=abc123");
    });

    it("returns URL as-is when already localhost", () => {
      const out = "http://localhost:18789/#token=xyz";
      assert.equal(parseDashboardUrlFromOutput(out), "http://localhost:18789/#token=xyz");
    });

    it("returns null when output has no URL with #token=", () => {
      assert.equal(parseDashboardUrlFromOutput("Dashboard at http://localhost:18789/"), null);
      assert.equal(parseDashboardUrlFromOutput("no url here"), null);
    });

    it("returns null for empty or non-string input", () => {
      assert.equal(parseDashboardUrlFromOutput(""), null);
      assert.equal(parseDashboardUrlFromOutput(null), null);
      assert.equal(parseDashboardUrlFromOutput(undefined), null);
    });
  });
});
