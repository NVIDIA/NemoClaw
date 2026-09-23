// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { patchLangfuseCredentials } from "../../../agents/hermes/patch-langfuse-credentials.mts";

const patcherPath = fileURLToPath(
  new URL("../../../agents/hermes/patch-langfuse-credentials.mts", import.meta.url),
);

const pinnedValidatorFixture = `\
import os
import re
import threading
from typing import Any, Dict, Optional

Langfuse = Any
_LANGFUSE_CLIENT = None
_INIT_FAILED = object()
_LANGFUSE_CLIENT_LOCK = threading.Lock()

class _Logger:
    def warning(self, *_args: Any) -> None:
        pass

logger = _Logger()

_LANGFUSE_KEY_PREFIXES: Dict[str, str] = {
    "HERMES_LANGFUSE_PUBLIC_KEY": "pk-lf-",
    "HERMES_LANGFUSE_SECRET_KEY": "sk-lf-",
}

def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()

def _secret(name: str) -> str:
    return _env(name)

def _validate_langfuse_key(env_name: str, value: str) -> Optional[str]:
    expected = _LANGFUSE_KEY_PREFIXES.get(env_name, "")
    if not expected or value.startswith(expected):
        return None
    preview = "<empty>" if not value else repr(value) if len(value) <= 12 else repr(value[:6] + "...")
    return f"{env_name}={preview} (expected {expected!r} prefix)"


def _settled_client() -> Any:
    return _LANGFUSE_CLIENT

def _settle_client() -> Any:
    global _LANGFUSE_CLIENT
    client = _build_client()
    _LANGFUSE_CLIENT = _INIT_FAILED if client is None else client
    return _LANGFUSE_CLIENT

def _get_langfuse() -> Optional[Langfuse]:
    settled = _settled_client()
    if settled is None:
        with _LANGFUSE_CLIENT_LOCK:
            settled = _settled_client()
            if settled is None:
                settled = _settle_client()
    return None if settled is _INIT_FAILED else settled

def _build_client() -> Optional[Langfuse]:
    public_key, secret_key = (_secret(f"HERMES_LANGFUSE_{n}") for n in ("PUBLIC_KEY", "SECRET_KEY"))
    if not (public_key and secret_key):
        return None
    placeholder_issues = [issue for issue in (
        _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", public_key),
        _validate_langfuse_key("HERMES_LANGFUSE_SECRET_KEY", secret_key),
    ) if issue]
    if placeholder_issues:
        return None
    kwargs: Dict[str, Any] = {"public_key": public_key, "secret_key": secret_key}
    for key, name, default in (("base_url", "BASE_URL", "https://cloud.langfuse.com"), ("environment", "ENV", ""),
                               ("release", "RELEASE", "")):
        value = _secret(f"HERMES_LANGFUSE_{name}") or default
        if value:
            kwargs[key] = value
    sample_rate = _secret("HERMES_LANGFUSE_SAMPLE_RATE")
    return kwargs
`;

const validatorAssertions = `\
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "pk-lf-public") is None
assert _validate_langfuse_key("HERMES_LANGFUSE_SECRET_KEY", "sk-lf-secret") is None
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "openshell:resolve:env:LANGFUSE_PUBLIC_KEY") is None
assert _validate_langfuse_key("HERMES_LANGFUSE_SECRET_KEY", "openshell:resolve:env:v0_LANGFUSE_SECRET_KEY") is None
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "openshell:resolve:env:v12345678901234567890_LANGFUSE_PUBLIC_KEY") is None
assert _validate_langfuse_key("HERMES_LANGFUSE_SECRET_KEY", "openshell:resolve:env:s${"a".repeat(64)}_LANGFUSE_SECRET_KEY") is None
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "openshell:resolve:env:LANGFUSE_SECRET_KEY") is not None
assert _validate_langfuse_key("HERMES_LANGFUSE_SECRET_KEY", "openshell:resolve:env:LANGFUSE_PUBLIC_KEY") is not None
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "openshell:resolve:env:v123456789012345678901_LANGFUSE_PUBLIC_KEY") is not None
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "openshell:resolve:env:s${"a".repeat(63)}_LANGFUSE_PUBLIC_KEY") is not None
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "openshell:resolve:env:s${"a".repeat(65)}_LANGFUSE_PUBLIC_KEY") is not None
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "openshell:resolve:env:s${"A".repeat(64)}_LANGFUSE_PUBLIC_KEY") is not None
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "prefix-openshell:resolve:env:LANGFUSE_PUBLIC_KEY") is not None
assert _validate_langfuse_base_url("https://cloud.langfuse.com") is None
assert _validate_langfuse_base_url("https://langfuse.example.test:8443/base") is None
assert _validate_langfuse_base_url("http://cloud.langfuse.com") is not None
assert _validate_langfuse_base_url("https://user:pass@cloud.langfuse.com") is not None
assert _validate_langfuse_base_url("https://cloud.langfuse.com?project=other") is not None
assert _validate_langfuse_base_url("https://cloud.langfuse.com#fragment") is not None
assert _validate_langfuse_base_url("https://cloud.langfuse.com:invalid") is not None
os.environ["HERMES_LANGFUSE_BASE_URL"] = "http://cloud.langfuse.com"
os.environ["HERMES_LANGFUSE_PUBLIC_KEY"] = "pk-lf-public"
os.environ["HERMES_LANGFUSE_SECRET_KEY"] = "sk-lf-secret"
assert _get_langfuse() is None
assert _LANGFUSE_CLIENT is _INIT_FAILED
del os.environ["HERMES_LANGFUSE_BASE_URL"]
`;

function runPython(source: string, assertions: string) {
  return spawnSync("python3", ["-I", "-c", `${source}\n${assertions}`], {
    encoding: "utf8",
  });
}

describe("Hermes Langfuse OpenShell credential compatibility", () => {
  it("accepts only raw keys or exact same-name resolver placeholders (#7446)", () => {
    const patched = patchLangfuseCredentials(pinnedValidatorFixture);
    const result = runPython(patched, validatorAssertions);

    expect(result.status, result.stderr).toBe(0);
    expect(patchLangfuseCredentials(patched)).toBe(patched);
  });

  it("fails closed when the pinned Hermes validator shape drifts (#7446)", () => {
    expect(() =>
      patchLangfuseCredentials(pinnedValidatorFixture.replace("pk-lf-", "pk-live-")),
    ).toThrow("Hermes Langfuse credential-name binding shape changed");
    expect(() =>
      patchLangfuseCredentials(
        `${pinnedValidatorFixture}\n${pinnedValidatorFixture.replace(
          "from typing import Any, Dict, Optional\n",
          "",
        )}`,
      ),
    ).toThrow("expected one unpatched block, found 2");
  });

  it("runs under the image build Node runtime and patches the requested file (#7446)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-langfuse-cli-"));
    const fixturePath = path.join(directory, "__init__.py");
    fs.writeFileSync(fixturePath, pinnedValidatorFixture, "utf8");

    const result = spawnSync(process.execPath, [patcherPath, fixturePath], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    const patched = fs.readFileSync(fixturePath, "utf8");
    const validation = runPython(patched, validatorAssertions);
    expect(validation.status, validation.stderr).toBe(0);
  });
});
