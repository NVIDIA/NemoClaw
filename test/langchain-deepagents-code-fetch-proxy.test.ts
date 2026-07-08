// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { addDarwinFcntlSealConstants } from "./helpers/darwin-fcntl-seal-fixture.ts";
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

  it("rejects consistently forged proxy env that differs from root-owned files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-proxy-root-"));
    try {
      const hostFile = path.join(tempDir, "dcode-proxy-host");
      const portFile = path.join(tempDir, "dcode-proxy-port");
      const runtimeFile = path.join(tempDir, "managed-dcode-runtime.py");
      fs.writeFileSync(hostFile, "trusted-proxy.internal\n", { mode: 0o444 });
      fs.writeFileSync(portFile, "3129\n", { mode: 0o444 });
      fs.writeFileSync(
        runtimeFile,
        addDarwinFcntlSealConstants(readAgentFile("managed-dcode-runtime.py")),
        "utf8",
      );
      const result = spawnSync(
        "python3",
        [
          "-c",
          `
import importlib.util
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "nemoclaw_managed_proxy_test",
    ${JSON.stringify(runtimeFile)},
)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
runtime._MANAGED_PROXY_HOST_FILE = Path(${JSON.stringify(hostFile)})
runtime._MANAGED_PROXY_PORT_FILE = Path(${JSON.stringify(portFile)})
runtime._MANAGED_FILE_OWNER_UID = os.getuid()

for name in (
    "DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
):
    os.environ[name] = "http://attacker.internal:4444"

try:
    runtime.managed_fetch_proxy_url()
except RuntimeError as exc:
    assert str(exc) == "managed fetch URL proxy does not match root-owned proxy"
    assert "attacker.internal" not in str(exc)
else:
    raise AssertionError("consistently forged proxy environment was accepted")

trusted = "http://trusted-proxy.internal:3129"
for name in (
    "DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
):
    os.environ[name] = trusted
os.environ["NO_PROXY"] = "raw.githubusercontent.com"
assert runtime.managed_fetch_proxy_url() == trusted
print("root-owned-proxy-verification-ok")
`,
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH } },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("root-owned-proxy-verification-ok");
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
      'expect_fetch_blocked "instance metadata" "https://169.254.169.254/latest/meta-data/"',
    );
    expect(check).toContain('expect_fetch_blocked "sandbox loopback" "https://127.0.0.1/"');
    expect(check).not.toContain("'403 client error: forbidden'");
  });
});
