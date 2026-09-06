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

def _redact_key_preview(value: str) -> str:
    return repr(value[:6] + "...")

def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()

def _validate_langfuse_key(env_name: str, value: str) -> Optional[str]:
    expected = _LANGFUSE_KEY_PREFIXES.get(env_name, "")
    if not expected:
        return None
    if value.startswith(expected):
        return None
    return (
        f"{env_name}={_redact_key_preview(value)} "
        f"(expected {expected!r} prefix)"
    )


def _get_langfuse() -> Optional[Langfuse]:
    global _LANGFUSE_CLIENT
    with _LANGFUSE_CLIENT_LOCK:
        base_url = _env("HERMES_LANGFUSE_BASE_URL") or _env("LANGFUSE_BASE_URL") or "https://cloud.langfuse.com"
        environment = _env("HERMES_LANGFUSE_ENV") or _env("LANGFUSE_ENV")
        return None
`;

const validatorAssertions = `\
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "pk-lf-public") is None
assert _validate_langfuse_key("HERMES_LANGFUSE_SECRET_KEY", "sk-lf-secret") is None
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "openshell:resolve:env:LANGFUSE_PUBLIC_KEY") is None
assert _validate_langfuse_key("HERMES_LANGFUSE_SECRET_KEY", "openshell:resolve:env:v0_LANGFUSE_SECRET_KEY") is None
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "openshell:resolve:env:v12345678901234567890_LANGFUSE_PUBLIC_KEY") is None
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "openshell:resolve:env:LANGFUSE_SECRET_KEY") is not None
assert _validate_langfuse_key("HERMES_LANGFUSE_SECRET_KEY", "openshell:resolve:env:LANGFUSE_PUBLIC_KEY") is not None
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "openshell:resolve:env:v123456789012345678901_LANGFUSE_PUBLIC_KEY") is not None
assert _validate_langfuse_key("HERMES_LANGFUSE_PUBLIC_KEY", "prefix-openshell:resolve:env:LANGFUSE_PUBLIC_KEY") is not None
assert _validate_langfuse_base_url("https://cloud.langfuse.com") is None
assert _validate_langfuse_base_url("https://langfuse.example.test:8443/base") is None
assert _validate_langfuse_base_url("http://cloud.langfuse.com") is not None
assert _validate_langfuse_base_url("https://user:pass@cloud.langfuse.com") is not None
assert _validate_langfuse_base_url("https://cloud.langfuse.com?project=other") is not None
assert _validate_langfuse_base_url("https://cloud.langfuse.com#fragment") is not None
assert _validate_langfuse_base_url("https://cloud.langfuse.com:invalid") is not None
os.environ["HERMES_LANGFUSE_BASE_URL"] = "http://cloud.langfuse.com"
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

    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", patcherPath, fixturePath],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    const patched = fs.readFileSync(fixturePath, "utf8");
    const validation = runPython(patched, validatorAssertions);
    expect(validation.status, validation.stderr).toBe(0);
  });
});
