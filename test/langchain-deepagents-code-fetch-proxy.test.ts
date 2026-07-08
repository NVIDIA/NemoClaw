// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  makeStartScriptFixture,
  runStartScriptProxyProbe,
  TRUSTED_FETCH_PROXY_ENV_NAME,
} from "./helpers/langchain-deepagents-code-headless.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const agentDir = path.join(repoRoot, "agents", "langchain-deepagents-code");

function readAgentFile(name: string): string {
  return fs.readFileSync(path.join(agentDir, name), "utf8");
}

describe("LangChain Deep Agents Code managed fetch proxy", () => {
  it("persists the root-owned proxy as the explicit fetch_url delegation", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-fetch-proxy-"));
    try {
      const { envFile, scriptPath } = makeStartScriptFixture(tempDir, readAgentFile("start.sh"));
      const { envFileText, output } = runStartScriptProxyProbe(scriptPath, envFile, {});
      const managedProxy = "http://10.200.0.1:3128";
      const outputLines = output.trimEnd().split("\n");

      expect(outputLines).toContain(`RUNTIME_${TRUSTED_FETCH_PROXY_ENV_NAME}=${managedProxy}`);
      expect(outputLines).toContain(`SOURCED_${TRUSTED_FETCH_PROXY_ENV_NAME}=${managedProxy}`);
      expect(envFileText.trimEnd().split("\n")).toContain(
        `export ${TRUSTED_FETCH_PROXY_ENV_NAME}=${managedProxy}`,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("allows raw GitHub content only through GET and HEAD", () => {
    const policy = YAML.parse(readAgentFile("policy-additions.yaml")) as {
      network_policies?: Record<string, { endpoints?: Array<Record<string, unknown>> }>;
    };
    const rawGitHub = policy.network_policies?.github?.endpoints?.find(
      (endpoint) => endpoint.host === "raw.githubusercontent.com",
    );

    expect(rawGitHub).toEqual({
      host: "raw.githubusercontent.com",
      port: 443,
      protocol: "rest",
      enforcement: "enforce",
      rules: [
        { allow: { method: "GET", path: "/**" } },
        { allow: { method: "HEAD", path: "/**" } },
      ],
    });
  });

  it("exercises actual fetch_url success and denied-host paths in cloud E2E", () => {
    const check = fs.readFileSync(
      path.join(
        repoRoot,
        "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
      ),
      "utf8",
    );

    expect(check).toContain("fetch_url_probe_source");
    expect(check).toContain("from deepagents_code.tools import fetch_url");
    expect(check).toContain(TRUSTED_FETCH_PROXY_ENV_NAME);
    expect(check).toContain("expect_fetch_reached");
    expect(check).toContain("FETCH_SUCCESS:2[0-9]{2}:[1-9][0-9]*");
    expect(check).toContain("https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/README.md");
    expect(check).toContain('expect_fetch_blocked "unapproved hosts" "https://example.com/"');
    expect(check).toContain(
      'expect_fetch_blocked "instance metadata" "http://169.254.169.254/latest/meta-data/"',
    );
    expect(check).toContain('expect_fetch_blocked "sandbox loopback" "http://127.0.0.1/"');
  });
});
