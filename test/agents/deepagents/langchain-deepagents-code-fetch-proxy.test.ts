// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { prepareInitialSandboxCreatePolicy } from "../../../src/lib/onboard/initial-policy.ts";

import { addDarwinFcntlSealConstants } from "../../helpers/darwin-fcntl-seal-fixture.ts";
import {
  runStartScriptProxyProbe,
  TRUSTED_FETCH_PROXY_ENV_NAME,
} from "../../helpers/langchain-deepagents-code-headless.ts";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "../../helpers/langchain-deepagents-code-patch-fixture.ts";
import { dcodeStateDir, makeStartScriptFixture } from "../../support/dcode-start-script-fixture.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const agentDir = path.join(repoRoot, "agents", "langchain-deepagents-code");

afterEach(cleanupPackageFixtures);

function readAgentFile(name: string): string {
  return fs.readFileSync(path.join(agentDir, name), "utf8");
}

afterEach(cleanupPackageFixtures);

describe("LangChain Deep Agents Code managed fetch transport", () => {
  it.each(["_pinned_dns", "_is_blocked_ip"])(
    "refuses an upstream package missing the %s fetch guard",
    (symbol) => {
      const tempDir = createPackageFixture();
      const toolsPath = path.join(tempDir, "deepagents_code", "tools.py");
      fs.writeFileSync(
        toolsPath,
        fs.readFileSync(toolsPath, "utf8").replace(`def ${symbol}(`, `def removed${symbol}(`),
      );
      expect(() => patchFixture(tempDir)).toThrow(symbol);
    },
  );
  it("clears obsolete proxy delegation in startup and sourced shell environments", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-fetch-proxy-"));
    try {
      const { envFile, scriptPath } = makeStartScriptFixture(tempDir, {
        markerDir: dcodeStateDir(tempDir),
      });
      const { envFileText, output } = runStartScriptProxyProbe(scriptPath, envFile, {});
      const managedProxy = "__unset__";
      const outputLines = output.trimEnd().split("\n");

      expect(outputLines).toContain(`RUNTIME_${TRUSTED_FETCH_PROXY_ENV_NAME}=${managedProxy}`);
      expect(outputLines).toContain(`SOURCED_${TRUSTED_FETCH_PROXY_ENV_NAME}=${managedProxy}`);
      expect(envFileText.trimEnd().split("\n")).toContain(
        `unset NEMOCLAW_PROXY_HOST NEMOCLAW_PROXY_PORT ${TRUSTED_FETCH_PROXY_ENV_NAME}`,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects an unsafe managed provider identity before fetching", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-fetch-identity-"));
    try {
      const runtimeFile = path.join(tempDir, "managed-dcode-runtime.py");
      fs.writeFileSync(
        runtimeFile,
        addDarwinFcntlSealConstants(readAgentFile("managed-dcode-runtime.py")),
      );
      const result = spawnSync(
        "python3",
        [
          "-c",
          `
import importlib.util
import os
from pathlib import Path
spec = importlib.util.spec_from_file_location("managed", ${JSON.stringify(runtimeFile)})
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
identity = Path(${JSON.stringify(tempDir)}) / "provider"
runtime._UPSTREAM_PROVIDER_FILE = identity
runtime._MANAGED_FILE_OWNER_UID = os.getuid()
assert runtime._managed_fetch_uses_openshell() is False
identity.write_text("openai\\n")
identity.chmod(0o444)
assert runtime._managed_fetch_uses_openshell() is True
identity.chmod(0o644)
try:
    runtime.managed_fetch_with_redirects("https://example.com", timeout=3, max_redirects=5,
        original_fetch=lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("unsafe fallback")),
        validation_error=ValueError, pin_dns=None, is_blocked_ip=None)
except ValueError as exc:
    assert str(exc) == "managed upstream provider file has unsafe ownership or mode"
else:
    raise AssertionError("writable managed identity was accepted")
identity.unlink()
identity.symlink_to(identity.with_name("missing"))
try:
    runtime._managed_fetch_uses_openshell()
except RuntimeError as exc:
    assert str(exc) == "managed upstream provider file is missing or unsafe"
else:
    raise AssertionError("dangling identity symlink was accepted")
`,
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH } },
      );
      expect(result.status, result.stderr).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each(["example.com", "169.254.169.254", "127.0.0.1"])(
    "prepares read-only raw GitHub access without opening denied fetch targets [%s]",
    (deniedHost) => {
      const prepared = prepareInitialSandboxCreatePolicy(
        path.join(agentDir, "policy-additions.yaml"),
        [],
        {
          agentName: "langchain-deepagents-code",
          additionalPresets: ["observability-otlp-local"],
        },
      );

      try {
        const policy = YAML.parse(fs.readFileSync(prepared.policyPath, "utf8")) as {
          network_policies?: Record<string, { endpoints?: Array<Record<string, unknown>> }>;
        };
        const endpoints = Object.values(policy.network_policies ?? {}).flatMap(
          (networkPolicy) => networkPolicy.endpoints ?? [],
        );
        const rawGitHub = endpoints.find(
          (endpoint) => endpoint.host === "raw.githubusercontent.com",
        );

        expect(rawGitHub).toMatchObject({
          port: 443,
          protocol: "rest",
          enforcement: "enforce",
          rules: [
            { allow: { method: "GET", path: "/**" } },
            { allow: { method: "HEAD", path: "/**" } },
          ],
        });
        expect(rawGitHub).not.toHaveProperty("access");

        const effectiveHosts = new Set(endpoints.map((endpoint) => endpoint.host));

        expect(effectiveHosts, `${deniedHost} must remain denied by default`).not.toContain(
          deniedHost,
        );
      } finally {
        prepared.cleanup?.();
      }
    },
  );

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
    expect(check).toContain("_managed_fetch_uses_openshell");
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
        target = urlparse(_url)
        urllib3_connection.create_connection((target.hostname, target.port or 443))
        ca_contents = Path(kwargs["verify"]).read_text(encoding="utf-8")
        with state_lock:
            successful_ca_contents.append(ca_contents)
        return Response()

requests = types.ModuleType("requests")
requests.Session = Session
requests.exceptions = types.SimpleNamespace(TooManyRedirects=RuntimeError)
sys.modules["requests"] = requests

import ipaddress
import socket
from urllib.parse import urlparse
socket_calls = []
dns_answers = {}
def managed_dns(host, _port, **_kwargs):
    values = dns_answers.get(host, ["198.18.0.2"])
    if isinstance(values, Exception):
        raise values
    return [(socket.AF_INET6 if ":" in ip else socket.AF_INET,
             socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 0)) for ip in values]
socket.getaddrinfo = managed_dns
urllib3_connection = types.ModuleType("urllib3.util.connection")
def socket_boundary(address, *_args, **_kwargs):
    # The pinned upstream owner must pass a vetted numeric address, never a
    # hostname that could resolve again between validation and connection.
    ipaddress.ip_address(address[0])
    socket_calls.append(address)
    return object()
urllib3_connection.create_connection = socket_boundary
urllib3_util = types.ModuleType("urllib3.util")
urllib3_util.connection = urllib3_connection
sys.modules["urllib3"] = types.ModuleType("urllib3")
sys.modules["urllib3.util"] = urllib3_util
sys.modules["urllib3.util.connection"] = urllib3_connection

from deepagents_code import _nemoclaw_managed, tools

root = Path(${JSON.stringify(tempDir)})
provider_file = root / "managed-provider"
managed_ca_file = root / "managed-ca.pem"
attacker_ca_file = root / "attacker-ca.pem"
provider_file.write_text("openai\\n", encoding="utf-8")
managed_ca_file.write_text("trusted CA bundle\\n", encoding="utf-8")
attacker_ca_file.write_text("attacker CA bundle\\n", encoding="utf-8")
for trusted_file in (provider_file, managed_ca_file, attacker_ca_file):
    trusted_file.chmod(0o444)

_nemoclaw_managed._UPSTREAM_PROVIDER_FILE = provider_file
_nemoclaw_managed._MANAGED_FILE_OWNER_UID = os.getuid()

# Exercise the installed path without replacing the runtime's trust selector.
# Redirect only that projected runtime path into this test's isolated filesystem.
original_open = os.open
def open_projected_trust(path, flags, *args, **kwargs):
    assert Path(path) == Path("/run/openshell-supervisor-ca/material/ca-bundle.crt")
    global pinned_transport_count
    descriptor = original_open(managed_ca_file, flags, *args, **kwargs)
    with state_lock:
        pinned_transport_count += 1
        if pinned_transport_count == PINNED_FETCH_COUNT:
            pinned_ready.set()
    assert release_pinned.wait(10), "timed out waiting for concurrent CA bundle mutation"
    return descriptor
os.open = open_projected_trust

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

  it("keeps redirects and concurrent fetches on the mediated network without ambient proxies", () => {
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
        target = urlparse(url)
        urllib3_connection.create_connection((target.hostname, target.port or 443))
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

import ipaddress
import socket
from urllib.parse import urlparse
socket_calls = []
dns_answers = {}
def managed_dns(host, _port, **_kwargs):
    values = dns_answers.get(host, ["198.18.0.2"])
    if isinstance(values, Exception):
        raise values
    return [(socket.AF_INET6 if ":" in ip else socket.AF_INET,
             socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 0)) for ip in values]
socket.getaddrinfo = managed_dns
urllib3_connection = types.ModuleType("urllib3.util.connection")
def socket_boundary(address, *_args, **_kwargs):
    # The pinned upstream owner must pass a vetted numeric address, never a
    # hostname that could resolve again between validation and connection.
    ipaddress.ip_address(address[0])
    socket_calls.append(address)
    return object()
urllib3_connection.create_connection = socket_boundary
urllib3_util = types.ModuleType("urllib3.util")
urllib3_util.connection = urllib3_connection
sys.modules["urllib3"] = types.ModuleType("urllib3")
sys.modules["urllib3.util"] = urllib3_util
sys.modules["urllib3.util.connection"] = urllib3_connection

from deepagents_code import _nemoclaw_managed, tools


provider_file = Path(${JSON.stringify(tempDir)}) / "managed-provider"
managed_ca_file = Path(${JSON.stringify(tempDir)}) / "managed-ca.pem"
attacker_ca_file = Path(${JSON.stringify(tempDir)}) / "attacker-ca.pem"
writable_ca_file = Path(${JSON.stringify(tempDir)}) / "writable-sensitive-ca.pem"
symlink_ca_file = Path(${JSON.stringify(tempDir)}) / "symlink-sensitive-ca.pem"
provider_file.write_text("openai\\n", encoding="utf-8")
managed_ca_file.write_text("test CA bundle\\n", encoding="utf-8")
managed_ca_file.chmod(0o444)
attacker_ca_file.write_text("attacker CA bundle\\n", encoding="utf-8")
writable_ca_file.write_text("unsafe CA bundle\\n", encoding="utf-8")
writable_ca_file.chmod(0o666)
symlink_ca_file.symlink_to(managed_ca_file)
provider_file.chmod(0o444)
_nemoclaw_managed._UPSTREAM_PROVIDER_FILE = provider_file
_nemoclaw_managed._MANAGED_FETCH_CA_BUNDLE_FILE = managed_ca_file
_nemoclaw_managed._MANAGED_FILE_OWNER_UID = os.getuid()
os.environ["REQUESTS_CA_BUNDLE"] = "relative/../hostile-requests-ca.pem"
os.environ["CURL_CA_BUNDLE"] = "/missing/hostile-curl-ca.pem"
os.environ["SSL_CERT_FILE"] = "/missing/hostile-ssl-ca.pem"

def forbidden_public_only_dns(*_args, **_kwargs):
    raise AssertionError("managed fetch used the public-only upstream DNS guard")

tools._validate_url = forbidden_public_only_dns
expected_proxies = {}

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
    "proxies": {},
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

# Literal non-public destinations and resolved local sockets stop before a
# request. Each redirect receives the same admission and connection pinning.
for denied_url in (
    "https://127.0.0.1/", "https://127.1/", "https://2130706433/",
    "https://0x7f000001/", "https://0177.0.0.1/", "https://127.0.0.1./",
    "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://[2002:7f00:1::]/",
    "http://0.0.0.0/", "http://[::]/", "https://10.0.0.1/",
    "https://169.254.169.254/latest/meta-data/", "https://[fe80::1]/",
    "https://[fc00::1]/", "https://198.18.0.2/",
):
    for redirect in (False, True):
        calls.clear()
        socket_calls.clear()
        responses.clear()
        initial = "https://raw.githubusercontent.com/redirect" if redirect else denied_url
        if redirect:
            responses.append(Response(302, denied_url))
        try:
            tools._fetch_with_redirects(initial, timeout=8)
        except tools._UrlValidationError as exc:
            assert str(exc) == "URL destination is blocked"
        else:
            raise AssertionError("non-public literal reached transport")
        assert len(calls) == int(redirect)
        assert len(socket_calls) == int(redirect)
        assert all(address[0] == "198.18.0.2" for address in socket_calls)

for answers in (["127.0.0.1"], ["::1"], ["::ffff:127.0.0.1"], ["0.0.0.0"],
                ["::"], ["198.18.0.2", "127.0.0.1"]):
    dns_answers["loopback-alias.example"] = answers
    for redirect in (False, True):
        calls.clear()
        socket_calls.clear()
        responses.clear()
        denied_url = "https://loopback-alias.example/private"
        initial = "https://raw.githubusercontent.com/redirect" if redirect else denied_url
        if redirect:
            responses.append(Response(302, denied_url))
        try:
            tools._fetch_with_redirects(initial, timeout=8)
        except tools._UrlValidationError as exc:
            assert str(exc) == "URL destination is blocked"
        else:
            raise AssertionError("resolved local address reached transport")
        assert len(calls) == int(redirect)
        assert len(socket_calls) == int(redirect)

# A synthetic address is not an upstream destination. The runtime still owns
# its policy decision, including rejection after a hostname redirect.
expect_redirect_policy_denial(
    "https://raw.githubusercontent.com/example/redirect-to-rebind",
    "https://rebind.internal/private", "DNS-rebinding hostname",
)
assert all(address[0] == "198.18.0.2" for address in socket_calls)

# A second hostname lookup would return loopback. The actual connection owner
# receives the first vetted address and cannot perform that second lookup.
original_dns = socket.getaddrinfo
dns_lookups = []
def rebind_dns(host, port, **kwargs):
    dns_lookups.append(host)
    return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "",
             ("198.18.0.2" if len(dns_lookups) == 1 else "127.0.0.1", 0))]
socket.getaddrinfo = rebind_dns
calls.clear()
socket_calls.clear()
responses.clear()
try:
    assert tools._fetch_with_redirects("https://rebind.example/", timeout=8).status_code == 200
    assert dns_lookups == ["rebind.example"]
    assert socket_calls == [("198.18.0.2", 443)]
finally:
    socket.getaddrinfo = original_dns

# Valid public literals and synthetic IPv6 answers retain their supported route.
for candidate, answer, expected_host in (
    ("https://8.8.8.8/", "8.8.8.8", "8.8.8.8"),
    ("https://[2606:4700:4700::1111]/", "2606:4700:4700::1111", "2606:4700:4700::1111"),
    ("https://synthetic.example/", "fd00::1234", "synthetic.example"),
    ("https://täst.example/", "198.18.0.3", "xn--tst-qla.example"),
    ("https://raw.githubusercontent.com./", "198.18.0.4", "raw.githubusercontent.com."),
):
    dns_answers[expected_host] = [answer]
    socket_calls.clear()
    assert tools._fetch_with_redirects(candidate, timeout=8).status_code == 200
    assert socket_calls == [(answer, 443)]
    del dns_answers[expected_host]

for answer, error in (
    ([], "URL hostname resolved to no addresses"),
    (["not-an-address"], "URL hostname returned an invalid address"),
    (socket.gaierror("sensitive resolver detail"), "URL hostname could not be resolved"),
):
    dns_answers["unresolved.example"] = answer
    calls.clear()
    socket_calls.clear()
    try:
        tools._fetch_with_redirects("https://unresolved.example/", timeout=8)
    except tools._UrlValidationError as exc:
        assert str(exc) == error
    else:
        raise AssertionError("invalid DNS result reached transport")
    assert calls == [] and socket_calls == []

calls.clear()
socket_calls.clear()
try:
    tools._fetch_with_redirects("https://127%2e0%2e0%2e1/", timeout=8)
except tools._UrlValidationError as exc:
    assert str(exc) == "URL hostname is invalid"
else:
    raise AssertionError("encoded authority escaped admission")
assert calls == [] and socket_calls == []

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

calls.clear()
os.environ["HTTP_PROXY"] = "http://attacker.internal:4444"
os.environ["HTTPS_PROXY"] = "http://user:secret@attacker.internal:4444"
os.environ["ALL_PROXY"] = "socks5://attacker.internal:1080"
os.environ["NO_PROXY"] = "*"
os.environ["DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL"] = "http://attacker.internal:4444"
assert tools._fetch_with_redirects("https://raw.githubusercontent.com/example", timeout=8).status_code == 200
assert_managed_hops(["https://raw.githubusercontent.com/example"])

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
# must remain pinned to the original projected trust bytes.
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
managed_ca_file.chmod(0o444)

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
# Image-file ownership does not supply authority for runtime-projected trust.
_nemoclaw_managed._MANAGED_FILE_OWNER_UID = 0
descriptor, _ = _nemoclaw_managed._managed_fetch_ca_bundle()
_nemoclaw_managed._close_managed_fetch_ca_bundle(descriptor)
original_fstat = os.fstat
def foreign_owner_fstat(descriptor):
    metadata = list(original_fstat(descriptor))
    metadata[4] = os.geteuid() + 1
    return os.stat_result(metadata)
os.fstat = foreign_owner_fstat
try:
    _nemoclaw_managed._managed_fetch_ca_bundle()
except RuntimeError as exc:
    assert str(exc) == "managed fetch CA bundle is invalid"
else:
    raise AssertionError("wrong-owner CA bundle was accepted")
finally:
    os.fstat = original_fstat
_nemoclaw_managed._MANAGED_FILE_OWNER_UID = os.getuid()

for mode in (0o644, 0o544, 0o400):
    managed_ca_file.chmod(mode)
    try:
        _nemoclaw_managed._managed_fetch_ca_bundle()
    except RuntimeError as exc:
        assert str(exc) == "managed fetch CA bundle is invalid"
    else:
        raise AssertionError("CA bundle with a non-projected mode was accepted")
managed_ca_file.chmod(0o444)

# Each fetch keeps its own Session and CA descriptor. The upstream connection
# lock serializes transport without sharing environment-derived credentials.
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

  it("preserves upstream transport outside the managed image", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);

    const withoutDelegation = spawnSync(
      "python3",
      [
        "-c",
        [
          "from deepagents_code import tools, _nemoclaw_managed",
          "from pathlib import Path",
          `_nemoclaw_managed._UPSTREAM_PROVIDER_FILE = Path(${JSON.stringify(path.join(tempDir, "no-managed-provider"))})`,
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
