// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { addDarwinFcntlSealConstants } from "./helpers/darwin-fcntl-seal-fixture.ts";
import {
  makeStartScriptFixture,
  runStartScriptProxyProbe,
  TRUSTED_FETCH_PROXY_ENV_NAME,
} from "./helpers/langchain-deepagents-code-headless.ts";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "./helpers/langchain-deepagents-code-patch-fixture.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const agentDir = path.join(repoRoot, "agents", "langchain-deepagents-code");

afterEach(cleanupPackageFixtures);

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
      fs.chmodSync(hostFile, 0o444);
      fs.chmodSync(portFile, 0o444);
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

  it("pins the cloud E2E wiring for fetch_url success and denied-host paths", () => {
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

  it("routes fetch_url through only the explicit managed proxy without direct DNS", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const proxyUrl = "http://managed-proxy.internal:3128";
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import builtins
import os
import sys
import types
from pathlib import Path

calls = []
responses = []
sessions = []

class ProxyPolicyDenied(RuntimeError):
    pass

class Response:
    def __init__(self, status_code=200, location=None, error=None):
        self.status_code = status_code
        self.headers = {} if location is None else {"Location": location}
        self.error = error

    def raise_for_status(self):
        if self.error is not None:
            raise self.error
        return None

class Session:
    def __init__(self):
        self.trust_env = True
        self.closed = False
        sessions.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.closed = True

    def get(self, url, **kwargs):
        calls.append((self.trust_env, url, kwargs))
        return responses.pop(0) if responses else Response()

requests = types.ModuleType("requests")
requests.Session = Session
requests.exceptions = types.SimpleNamespace(TooManyRedirects=RuntimeError)
sys.modules["requests"] = requests

from deepagents_code import _nemoclaw_managed, tools
from deepagents_code._nemoclaw_managed import managed_fetch_proxy_url

proxy_host_file = Path(${JSON.stringify(tempDir)}) / "managed-proxy-host"
proxy_port_file = Path(${JSON.stringify(tempDir)}) / "managed-proxy-port"
managed_ca_file = Path(${JSON.stringify(tempDir)}) / "managed-ca.pem"
writable_ca_file = Path(${JSON.stringify(tempDir)}) / "writable-sensitive-ca.pem"
symlink_ca_file = Path(${JSON.stringify(tempDir)}) / "symlink-sensitive-ca.pem"
proxy_host_file.write_text("managed-proxy.internal\\n", encoding="utf-8")
proxy_port_file.write_text("3128\\n", encoding="utf-8")
managed_ca_file.write_text("test CA bundle\\n", encoding="utf-8")
writable_ca_file.write_text("unsafe CA bundle\\n", encoding="utf-8")
writable_ca_file.chmod(0o666)
symlink_ca_file.symlink_to(managed_ca_file)
proxy_host_file.chmod(0o444)
proxy_port_file.chmod(0o444)
_nemoclaw_managed._MANAGED_PROXY_HOST_FILE = proxy_host_file
_nemoclaw_managed._MANAGED_PROXY_PORT_FILE = proxy_port_file
_nemoclaw_managed._MANAGED_FETCH_CA_BUNDLE_FILE = managed_ca_file
_nemoclaw_managed._MANAGED_FILE_OWNER_UID = os.getuid()
os.environ["REQUESTS_CA_BUNDLE"] = "relative/../hostile-requests-ca.pem"
os.environ["CURL_CA_BUNDLE"] = "/missing/hostile-curl-ca.pem"
os.environ["SSL_CERT_FILE"] = "/missing/hostile-ssl-ca.pem"

def forbidden_direct_dns(*_args, **_kwargs):
    raise AssertionError("managed fetch attempted direct DNS validation")

tools._validate_url = forbidden_direct_dns
response = tools._fetch_with_redirects("https://raw.githubusercontent.com/example/repo/main/README.md", timeout=8)
assert response.status_code == 200
assert len(sessions) == 1 and sessions[0].closed
assert calls == [(
    False,
    "https://raw.githubusercontent.com/example/repo/main/README.md",
    {
        "timeout": 8,
        "headers": {"User-Agent": "Mozilla/5.0 (compatible; DeepAgents/1.0)"},
        "allow_redirects": False,
        "proxies": {"http": ${JSON.stringify(proxyUrl)}, "https": ${JSON.stringify(proxyUrl)}},
        "verify": str(managed_ca_file),
    },
)]

calls.clear()
path_data_url = "https://raw.githubusercontent.com/example/path@segment:ordinary-data"
response = tools._fetch_with_redirects(path_data_url, timeout=8)
assert response.status_code == 200
assert calls[0][1] == path_data_url

calls.clear()
redirect_path_data_url = "https://raw.githubusercontent.com/example/@user:pass/source.py"
responses.extend([Response(302, redirect_path_data_url), Response(200)])
response = tools._fetch_with_redirects(
    "https://raw.githubusercontent.com/path-data-redirect",
    timeout=8,
)
assert response.status_code == 200
assert [url for _, url, _ in calls] == [
    "https://raw.githubusercontent.com/path-data-redirect",
    redirect_path_data_url,
]

calls.clear()
responses.extend([
    Response(302, "../main/README.md"),
    Response(),
])
response = tools._fetch_with_redirects(
    "https://raw.githubusercontent.com/example/repo/start",
    timeout=8,
)
assert response.status_code == 200
assert [url for _, url, _ in calls] == [
    "https://raw.githubusercontent.com/example/repo/start",
    "https://raw.githubusercontent.com/example/main/README.md",
]
assert all(
    kwargs["proxies"]
    == {"http": ${JSON.stringify(proxyUrl)}, "https": ${JSON.stringify(proxyUrl)}}
    for _, _, kwargs in calls
)
assert all(kwargs["verify"] == str(managed_ca_file) for _, _, kwargs in calls)

calls.clear()
responses.append(Response(302))
try:
    tools._fetch_with_redirects("https://raw.githubusercontent.com/missing-location", timeout=8)
except tools._UrlValidationError as exc:
    assert "missing a Location header" in str(exc)
else:
    raise AssertionError("redirect without Location escaped validation")

calls.clear()
responses.append(Response(302, "https://user:redirect-secret@raw.githubusercontent.com/private"))
try:
    tools._fetch_with_redirects("https://raw.githubusercontent.com/credential-redirect", timeout=8)
except tools._UrlValidationError as exc:
    assert str(exc) == "URL credentials are not allowed"
    assert "redirect-secret" not in str(exc)
else:
    raise AssertionError("credentialed redirect escaped validation")
assert len(calls) == 1

for label, redirect_url in (
    ("cross-host metadata", "http://169.254.169.254/latest/meta-data/"),
    ("DNS-rebinding hostname", "https://rebind.internal/private"),
):
    calls.clear()
    responses.extend([
        Response(302, redirect_url),
        Response(403, error=ProxyPolicyDenied(f"network policy denied {label}")),
    ])
    try:
        tools._fetch_with_redirects(
            "https://raw.githubusercontent.com/allowed/start",
            timeout=8,
        )
    except ProxyPolicyDenied as exc:
        assert str(exc) == f"network policy denied {label}"
    else:
        raise AssertionError(f"{label} redirect escaped proxy policy denial")
    assert [url for _, url, _ in calls] == [
        "https://raw.githubusercontent.com/allowed/start",
        redirect_url,
    ]
    assert all(
        kwargs["proxies"]
        == {"http": ${JSON.stringify(proxyUrl)}, "https": ${JSON.stringify(proxyUrl)}}
        for _, _, kwargs in calls
    )

calls.clear()
responses.append(Response(302, "https://raw.githubusercontent.com/next"))
tools._MAX_FETCH_REDIRECTS = 0
try:
    tools._fetch_with_redirects("https://raw.githubusercontent.com/start", timeout=8)
except RuntimeError as exc:
    assert "Exceeded 0 redirects" in str(exc)
else:
    raise AssertionError("managed fetch ignored the reviewed upstream redirect cap")
assert len(calls) == 1

tools._MAX_FETCH_REDIRECTS = 5
for malformed in ("https://[broken", "https://example.com:not-a-port"):
    try:
        tools._fetch_with_redirects(malformed, timeout=8)
    except tools._UrlValidationError as exc:
        assert str(exc) == "URL is malformed"
    else:
        raise AssertionError(f"malformed URL escaped validation: {malformed}")

os.environ["HTTP_PROXY"] = "http://attacker.internal:4444"
try:
    tools._fetch_with_redirects("https://raw.githubusercontent.com/example", timeout=8)
except tools._UrlValidationError as exc:
    assert str(exc) == "managed fetch URL proxy does not match runtime proxy"
    assert "attacker.internal" not in str(exc)
else:
    raise AssertionError("proxy-integrity error escaped fetch_url validation")

for invalid_proxy in (
    "http://user:proxy-secret@proxy.internal:3128",
    "http://proxy.internal",
    "http://proxy.internal:0",
    "http://proxy.internal:70000",
    "http://proxy.internal:3128/unexpected",
    "http://proxy.internal:3128?route=unsafe",
    "http://proxy.internal:3128#fragment",
    " http://proxy.internal:3128",
    "http://proxy.internal:3128\\n",
):
    os.environ["DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL"] = invalid_proxy
    for proxy_name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        os.environ[proxy_name] = invalid_proxy
    try:
        managed_fetch_proxy_url()
    except RuntimeError as exc:
        assert str(exc) == "managed fetch URL proxy is invalid"
        assert "proxy-secret" not in str(exc)
    else:
        raise AssertionError(f"invalid managed proxy was accepted: {invalid_proxy!r}")

for proxy_name in (
    "DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
):
    os.environ[proxy_name] = ${JSON.stringify(proxyUrl)}

original_import = builtins.__import__
def block_requests_import(name, *args, **kwargs):
    if name == "requests":
        raise ImportError("private import detail from /sensitive/runtime/path")
    return original_import(name, *args, **kwargs)

builtins.__import__ = block_requests_import
try:
    tools._fetch_with_redirects("https://raw.githubusercontent.com/example", timeout=8)
except tools._UrlValidationError as exc:
    assert str(exc) == "managed fetch transport dependency is unavailable"
    assert "ImportError" not in str(exc)
    assert "sensitive" not in str(exc)
    assert exc.__cause__ is None
    assert exc.__suppress_context__ is True
else:
    raise AssertionError("requests ImportError escaped the structured validation path")
finally:
    builtins.__import__ = original_import

for invalid_ca_bundle, expected_error in (
    (
        Path(${JSON.stringify(tempDir)}) / "missing-sensitive-ca.pem",
        "managed fetch CA bundle is unavailable",
    ),
    (symlink_ca_file, "managed fetch CA bundle is invalid"),
    (writable_ca_file, "managed fetch CA bundle is invalid"),
):
    _nemoclaw_managed._MANAGED_FETCH_CA_BUNDLE_FILE = invalid_ca_bundle
    try:
        tools._fetch_with_redirects("https://raw.githubusercontent.com/example", timeout=8)
    except tools._UrlValidationError as exc:
        assert str(exc) == expected_error
        assert "sensitive" not in str(exc)
        assert exc.__cause__ is None
    else:
        raise AssertionError(f"invalid CA bundle was accepted: {invalid_ca_bundle!r}")

_nemoclaw_managed._MANAGED_FETCH_CA_BUNDLE_FILE = managed_ca_file
_nemoclaw_managed._MANAGED_FILE_OWNER_UID = os.getuid() + 1
try:
    _nemoclaw_managed._managed_fetch_ca_bundle()
except RuntimeError as exc:
    assert str(exc) == "managed fetch CA bundle is invalid"
else:
    raise AssertionError("wrong-owner CA bundle was accepted")
_nemoclaw_managed._MANAGED_FILE_OWNER_UID = os.getuid()
assert sessions and all(session.closed for session in sessions)
assert len({id(session) for session in sessions}) == len(sessions)
print("managed-fetch-proxy-ok")
`,
      ],
      {
        env: {
          PATH: process.env.PATH,
          PYTHONPATH: tempDir,
          DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL: proxyUrl,
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          NO_PROXY: "raw.githubusercontent.com",
          no_proxy: "raw.githubusercontent.com",
        },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("managed-fetch-proxy-ok");

    const withoutDelegation = spawnSync(
      "python3",
      [
        "-c",
        [
          "from deepagents_code import tools",
          'result = tools._fetch_with_redirects("https://example.com", timeout=3)',
          'assert result == {"transport": "direct", "url": "https://example.com", "timeout": 3}',
        ].join("; "),
      ],
      {
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
        encoding: "utf8",
      },
    );
    expect(withoutDelegation.status, withoutDelegation.stderr).toBe(0);
  });
});
