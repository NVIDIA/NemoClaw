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

afterEach(cleanupPackageFixtures);

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

  it("pins concurrent CA bundle mutation fetches to original trust bytes or generic failure", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const proxyUrl = "http://managed-proxy.internal:3128";
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import os
import sys
import types
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event, Lock, Thread

PINNED_FETCH_COUNT = 4
INVALID_FETCH_COUNT = 2
pinned_ready = Event()
swap_complete = Event()
invalid_attempts_complete = Event()
release_pinned = Event()
state_lock = Lock()
pinned_transport_count = 0
successful_ca_contents = []
sessions = []
mutation_errors = []

class Response:
    status_code = 200
    headers = {}

    def raise_for_status(self):
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

    def get(self, _url, **kwargs):
        global pinned_transport_count
        with state_lock:
            pinned_transport_count += 1
            if pinned_transport_count == PINNED_FETCH_COUNT:
                pinned_ready.set()
        assert release_pinned.wait(10), "timed out waiting for concurrent CA bundle mutation"
        ca_contents = Path(kwargs["verify"]).read_text(encoding="utf-8")
        with state_lock:
            successful_ca_contents.append(ca_contents)
        return Response()

requests = types.ModuleType("requests")
requests.Session = Session
requests.exceptions = types.SimpleNamespace(TooManyRedirects=RuntimeError)
sys.modules["requests"] = requests

from deepagents_code import _nemoclaw_managed, tools

root = Path(${JSON.stringify(tempDir)})
proxy_host_file = root / "managed-proxy-host"
proxy_port_file = root / "managed-proxy-port"
managed_ca_file = root / "managed-ca.pem"
attacker_ca_file = root / "attacker-ca.pem"
proxy_host_file.write_text("managed-proxy.internal\\n", encoding="utf-8")
proxy_port_file.write_text("3128\\n", encoding="utf-8")
managed_ca_file.write_text("trusted CA bundle\\n", encoding="utf-8")
attacker_ca_file.write_text("attacker CA bundle\\n", encoding="utf-8")
for trusted_file in (proxy_host_file, proxy_port_file, managed_ca_file, attacker_ca_file):
    trusted_file.chmod(0o444)

_nemoclaw_managed._MANAGED_PROXY_HOST_FILE = proxy_host_file
_nemoclaw_managed._MANAGED_PROXY_PORT_FILE = proxy_port_file
_nemoclaw_managed._MANAGED_FETCH_CA_BUNDLE_FILE = managed_ca_file
_nemoclaw_managed._MANAGED_FILE_OWNER_UID = os.getuid()

for name in (
    "DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
):
    os.environ[name] = ${JSON.stringify(proxyUrl)}

def fetch_outcome(index):
    try:
        response = tools._fetch_with_redirects(
            f"https://raw.githubusercontent.com/example/concurrent-ca-bundle-{index}",
            timeout=8,
        )
    except tools._UrlValidationError as exc:
        return ("error", str(exc))
    return ("success", response.status_code)

def atomically_symlink_swap_ca_bundle():
    try:
        assert pinned_ready.wait(10), "managed fetches did not reach the pinned transport"
        replacement = root / "managed-ca-symlink-replacement"
        replacement.symlink_to(attacker_ca_file)
        os.replace(replacement, managed_ca_file)
        swap_complete.set()
        assert invalid_attempts_complete.wait(10), "invalid fetches did not observe CA mutation"
    except BaseException as exc:
        mutation_errors.append(repr(exc))
        swap_complete.set()
    finally:
        release_pinned.set()

mutator = Thread(target=atomically_symlink_swap_ca_bundle, name="ca-bundle-mutator")
mutator.start()
with ThreadPoolExecutor(max_workers=PINNED_FETCH_COUNT + INVALID_FETCH_COUNT) as executor:
    try:
        pinned_futures = [executor.submit(fetch_outcome, index) for index in range(PINNED_FETCH_COUNT)]
        assert swap_complete.wait(10), "atomic CA bundle swap did not complete"
        invalid_futures = [
            executor.submit(fetch_outcome, PINNED_FETCH_COUNT + index)
            for index in range(INVALID_FETCH_COUNT)
        ]
        invalid_results = [future.result(timeout=10) for future in invalid_futures]
        invalid_attempts_complete.set()
        pinned_results = [future.result(timeout=10) for future in pinned_futures]
    finally:
        invalid_attempts_complete.set()
        release_pinned.set()

mutator.join(timeout=10)
assert not mutator.is_alive()
assert mutation_errors == []
assert pinned_results == [("success", 200)] * PINNED_FETCH_COUNT
assert invalid_results == [
    ("error", "managed fetch CA bundle is invalid")
] * INVALID_FETCH_COUNT
assert successful_ca_contents == ["trusted CA bundle\\n"] * PINNED_FETCH_COUNT
assert all("attacker" not in contents for contents in successful_ca_contents)
assert managed_ca_file.is_symlink()
assert managed_ca_file.read_text(encoding="utf-8") == "attacker CA bundle\\n"
assert len(sessions) == PINNED_FETCH_COUNT
assert all(session.closed for session in sessions)
print("concurrent-ca-bundle-mutation-ok")
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
        },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("concurrent-ca-bundle-mutation-ok");
  });

  it("keeps redirects and concurrent fetches behind the explicit proxy without direct DNS", () => {
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
import socket
import sys
import types
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Thread

calls = []
responses = []
sessions = []
ca_swap_thread = None

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
        self.calls = []
        self.ca_contents = []
        self.closed = False
        sessions.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.closed = True

    def get(self, url, **kwargs):
        global ca_swap_thread
        if ca_swap_thread is not None:
            thread = ca_swap_thread
            ca_swap_thread = None
            thread.start()
            thread.join()
            assert not thread.is_alive()
        self.ca_contents.append(Path(kwargs["verify"]).read_text(encoding="utf-8"))
        call = (self.trust_env, url, kwargs)
        self.calls.append(call)
        calls.append(call)
        return responses.pop(0) if responses else Response()

requests = types.ModuleType("requests")
requests.Session = Session
requests.exceptions = types.SimpleNamespace(HTTPError=ProxyPolicyDenied, TooManyRedirects=RuntimeError)
sys.modules["requests"] = requests

from deepagents_code import _nemoclaw_managed, tools
from deepagents_code._nemoclaw_managed import managed_fetch_proxy_url

proxy_host_file = Path(${JSON.stringify(tempDir)}) / "managed-proxy-host"
proxy_port_file = Path(${JSON.stringify(tempDir)}) / "managed-proxy-port"
managed_ca_file = Path(${JSON.stringify(tempDir)}) / "managed-ca.pem"
attacker_ca_file = Path(${JSON.stringify(tempDir)}) / "attacker-ca.pem"
writable_ca_file = Path(${JSON.stringify(tempDir)}) / "writable-sensitive-ca.pem"
symlink_ca_file = Path(${JSON.stringify(tempDir)}) / "symlink-sensitive-ca.pem"
proxy_host_file.write_text("managed-proxy.internal\\n", encoding="utf-8")
proxy_port_file.write_text("3128\\n", encoding="utf-8")
managed_ca_file.write_text("test CA bundle\\n", encoding="utf-8")
attacker_ca_file.write_text("attacker CA bundle\\n", encoding="utf-8")
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
expected_proxies = {"http": ${JSON.stringify(proxyUrl)}, "https": ${JSON.stringify(proxyUrl)}}

def assert_fd_ca_path(candidate):
    assert candidate.startswith(("/proc/self/fd/", "/dev/fd/"))

def assert_managed_hops(expected_urls):
    assert [url for _, url, _ in calls] == expected_urls
    assert all(trust_env is False for trust_env, _, _ in calls)
    assert all(kwargs["proxies"] == expected_proxies for _, _, kwargs in calls)
    assert all(
        kwargs["verify"].startswith(("/proc/self/fd/", "/dev/fd/"))
        for _, _, kwargs in calls
    )
    assert sessions[-1].ca_contents == ["test CA bundle\\n"] * len(expected_urls)

def expect_redirect_policy_denial(initial_url, redirect_url, label):
    calls.clear()
    denial = ProxyPolicyDenied(f"network policy denied {label}")
    responses.extend([Response(302, redirect_url), Response(403, error=denial)])
    try:
        tools._fetch_with_redirects(initial_url, timeout=8)
    except ProxyPolicyDenied as exc:
        assert exc is denial
        assert str(exc) == f"network policy denied {label}"
    else:
        raise AssertionError(f"{label} redirect escaped proxy policy denial")
    assert_managed_hops([initial_url, redirect_url])

response = tools._fetch_with_redirects("https://raw.githubusercontent.com/example/repo/main/README.md", timeout=8)
assert response.status_code == 200
assert len(sessions) == 1 and sessions[0].closed
assert len(calls) == 1
trust_env, called_url, call_kwargs = calls[0]
assert trust_env is False
assert called_url == "https://raw.githubusercontent.com/example/repo/main/README.md"
assert {
    key: value for key, value in call_kwargs.items() if key != "verify"
} == {
    "timeout": 8,
    "headers": {"User-Agent": "Mozilla/5.0 (compatible; DeepAgents/1.0)"},
    "allow_redirects": False,
    "proxies": {"http": ${JSON.stringify(proxyUrl)}, "https": ${JSON.stringify(proxyUrl)}},
}
assert_fd_ca_path(call_kwargs["verify"])
assert sessions[0].ca_contents == ["test CA bundle\\n"]

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
assert_managed_hops([
    "https://raw.githubusercontent.com/example/repo/start",
    "https://raw.githubusercontent.com/example/main/README.md",
])

# Cross-host redirects remain behind the same explicit proxy. The adapter does
# not locally authorize IMDS; it propagates the policy proxy's denial. The live
# egress check separately proves that OpenShell denies the IMDS destination.
metadata_url = "https://169.254.169.254/latest/meta-data/"
expect_redirect_policy_denial(
    "https://raw.githubusercontent.com/example/redirect-to-imds",
    metadata_url,
    "cross-host metadata",
)

# DNS and resolved-IP policy belong to OpenShell. A rebinding candidate must be
# passed by hostname through the explicit proxy without local DNS, and the
# proxy's denial must propagate rather than triggering a direct retry.
rebind_url = "https://rebind.internal/private"
original_getaddrinfo = socket.getaddrinfo
def forbidden_local_dns(*_args, **_kwargs):
    raise AssertionError("managed redirect attempted local DNS")
socket.getaddrinfo = forbidden_local_dns
try:
    expect_redirect_policy_denial(
        "https://raw.githubusercontent.com/example/redirect-to-rebind",
        rebind_url,
        "DNS-rebinding hostname",
    )
finally:
    socket.getaddrinfo = original_getaddrinfo

calls.clear()
responses.append(Response(302))
try:
    tools._fetch_with_redirects("https://raw.githubusercontent.com/missing-location", timeout=8)
except tools._UrlValidationError as exc:
    assert "missing a Location header" in str(exc)
else:
    raise AssertionError("redirect without Location escaped validation")

calls.clear()
responses.append(Response(302, "http://user:redirect-secret@proxy.internal:3128/private"))
try:
    tools._fetch_with_redirects("https://raw.githubusercontent.com/credential-redirect", timeout=8)
except tools._UrlValidationError as exc:
    assert str(exc) == "URL credentials are not allowed"
    assert "redirect-secret" not in str(exc)
else:
    raise AssertionError("credentialed redirect escaped validation")
assert len(calls) == 1

sensitive_idna_label = "sk-EXAMPLE-DO-NOT-REFLECT"
invalid_idna_url = f"https://{sensitive_idna_label}{chr(0xD800)}.invalid/private"
calls.clear()
try:
    tools._fetch_with_redirects(invalid_idna_url, timeout=8)
except tools._UrlValidationError as exc:
    assert str(exc) == "URL hostname is not valid IDNA"
    assert sensitive_idna_label not in str(exc)
    assert "Unicode" not in str(exc)
    assert exc.__cause__ is None
    assert exc.__suppress_context__ is True
else:
    raise AssertionError("invalid initial IDNA hostname escaped validation")
assert calls == []

calls.clear()
responses.append(Response(302, invalid_idna_url))
try:
    tools._fetch_with_redirects("https://raw.githubusercontent.com/idna-redirect", timeout=8)
except tools._UrlValidationError as exc:
    assert str(exc) == "URL hostname is not valid IDNA"
    assert sensitive_idna_label not in str(exc)
    assert "Unicode" not in str(exc)
    assert exc.__cause__ is None
    assert exc.__suppress_context__ is True
else:
    raise AssertionError("invalid redirect IDNA hostname escaped validation")
assert len(calls) == 1

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

# Atomically replace the validated pathname after the managed helper opens it,
# but before the transport consumes the CA input. The fd-backed verify path
# must remain pinned to the original root-owned trust bytes.
def replace_managed_ca_path():
    replacement = managed_ca_file.with_name("managed-ca-replacement")
    if replacement.exists() or replacement.is_symlink():
        replacement.unlink()
    replacement.symlink_to(attacker_ca_file)
    os.replace(replacement, managed_ca_file)

calls.clear()
ca_swap_thread = Thread(target=replace_managed_ca_path)
response = tools._fetch_with_redirects(
    "https://raw.githubusercontent.com/example/ca-swap",
    timeout=8,
)
assert response.status_code == 200
assert managed_ca_file.is_symlink()
assert managed_ca_file.read_text(encoding="utf-8") == "attacker CA bundle\\n"
assert sessions[-1].ca_contents == ["test CA bundle\\n"]
assert_fd_ca_path(calls[0][2]["verify"])
managed_ca_file.unlink()
managed_ca_file.write_text("test CA bundle\\n", encoding="utf-8")

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

# The proxy and CA are immutable process-wide image inputs. Per-call isolation
# therefore means a fresh Session and explicit proxy mapping for each fetch,
# including concurrent calls, rather than unsupported mutable configurations.
calls.clear()
session_start = len(sessions)
concurrent_urls = [
    f"https://raw.githubusercontent.com/example/concurrent-{index}"
    for index in range(4)
]
with ThreadPoolExecutor(max_workers=len(concurrent_urls)) as executor:
    concurrent_responses = list(executor.map(
        lambda candidate: tools._fetch_with_redirects(candidate, timeout=8),
        concurrent_urls,
    ))
concurrent_sessions = sessions[session_start:]
assert all(response.status_code == 200 for response in concurrent_responses)
assert len(concurrent_sessions) == len(concurrent_urls)
assert all(session.trust_env is False for session in concurrent_sessions)
assert all(len(session.calls) == 1 for session in concurrent_sessions)
assert {session.calls[0][1] for session in concurrent_sessions} == set(concurrent_urls)
assert all(
    session.calls[0][2]["proxies"] == expected_proxies
    for session in concurrent_sessions
)
assert all(
    session.calls[0][2]["verify"].startswith(("/proc/self/fd/", "/dev/fd/"))
    for session in concurrent_sessions
)
assert all(
    session.ca_contents == ["test CA bundle\\n"]
    for session in concurrent_sessions
)
assert len({id(session.calls[0][2]["proxies"]) for session in concurrent_sessions}) == len(
    concurrent_sessions
)
assert all(session.closed for session in concurrent_sessions)
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
  });

  it("preserves unmanaged fallback when proxy env is absent", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);

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
