// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * Patch the Langfuse validator bundled with pinned Hermes v2026.7.20 / 0.19.0.
 *
 * Hermes rejects OpenShell resolver placeholders before the Langfuse SDK can
 * turn them into outbound authentication headers. NemoClaw keeps the real
 * values in the OpenShell provider and exposes only these placeholders inside
 * the sandbox. Exact source blocks make the image build fail closed when the
 * pinned Hermes implementation drifts.
 *
 * Remove this patch when the pinned Hermes release natively accepts exact,
 * same-name OpenShell placeholders, retains its raw-key prefix checks, and
 * rejects non-HTTPS authenticated Langfuse base URLs. Issue #7446 tracks that
 * removal condition.
 */
const DEFAULT_PLUGIN_PATH = "/opt/hermes/plugins/observability/langfuse/__init__.py";

const replacements = [
  {
    name: "HTTPS URL parser",
    old: `from typing import Any, Dict, Optional\n`,
    patched: `from typing import Any, Dict, Optional\nfrom urllib.parse import urlsplit\n`,
  },
  {
    name: "credential-name binding",
    old: `\
_LANGFUSE_KEY_PREFIXES: Dict[str, str] = {
    "HERMES_LANGFUSE_PUBLIC_KEY": "pk-lf-",
    "HERMES_LANGFUSE_SECRET_KEY": "sk-lf-",
}
`,
    patched: `\
_LANGFUSE_KEY_PREFIXES: Dict[str, str] = {
    "HERMES_LANGFUSE_PUBLIC_KEY": "pk-lf-",
    "HERMES_LANGFUSE_SECRET_KEY": "sk-lf-",
}
_LANGFUSE_OPENSHELL_KEYS: Dict[str, str] = {
    "HERMES_LANGFUSE_PUBLIC_KEY": "LANGFUSE_PUBLIC_KEY",
    "HERMES_LANGFUSE_SECRET_KEY": "LANGFUSE_SECRET_KEY",
}
`,
  },
  {
    name: "credential validation",
    old: `\
    if value.startswith(expected):
        return None
    return (
`,
    patched: `\
    if value.startswith(expected):
        return None
    openshell_key = _LANGFUSE_OPENSHELL_KEYS.get(env_name)
    # Keep the revision bound aligned with NemoClaw's OpenShell credential
    # observation contract in mcp-bridge-provider-readiness.ts.
    if openshell_key and re.fullmatch(
        rf"openshell:resolve:env:(?:v[0-9]{{1,20}}_)?{re.escape(openshell_key)}",
        value,
    ):
        return None
    return (
`,
  },
  {
    name: "HTTPS base URL validation",
    old: `\
    return (
        f"{env_name}={_redact_key_preview(value)} "
        f"(expected {expected!r} prefix)"
    )


def _get_langfuse() -> Optional[Langfuse]:
`,
    patched: `\
    return (
        f"{env_name}={_redact_key_preview(value)} "
        f"(expected {expected!r} prefix)"
    )


def _validate_langfuse_base_url(value: str) -> Optional[str]:
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError:
        return "HERMES_LANGFUSE_BASE_URL must be a valid absolute HTTPS URL"
    if (
        parsed.scheme.lower() != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        return (
            "HERMES_LANGFUSE_BASE_URL must be an absolute HTTPS URL "
            "without credentials, query parameters, or a fragment"
        )
    return None


def _get_langfuse() -> Optional[Langfuse]:
`,
  },
  {
    name: "HTTPS base URL gate",
    old: `\
    base_url = _env("HERMES_LANGFUSE_BASE_URL") or _env("LANGFUSE_BASE_URL") or "https://cloud.langfuse.com"
    environment = _env("HERMES_LANGFUSE_ENV") or _env("LANGFUSE_ENV")
`,
    patched: `\
    base_url = _env("HERMES_LANGFUSE_BASE_URL") or _env("LANGFUSE_BASE_URL") or "https://cloud.langfuse.com"
    base_url_issue = _validate_langfuse_base_url(base_url)
    if base_url_issue:
        logger.warning(
            "Langfuse plugin: invalid base URL, traces will NOT be emitted (%s).",
            base_url_issue,
        )
        _LANGFUSE_CLIENT = _INIT_FAILED
        return None
    environment = _env("HERMES_LANGFUSE_ENV") or _env("LANGFUSE_ENV")
`,
  },
] as const;

function countOccurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

export function patchLangfuseCredentials(source: string): string {
  let result = source;
  for (const replacement of replacements) {
    const oldCount = countOccurrences(result, replacement.old);
    const patchedCount = countOccurrences(result, replacement.patched);
    if (patchedCount === 1 && oldCount <= 1) continue;
    if (oldCount !== 1 || patchedCount !== 0) {
      throw new Error(
        `Hermes Langfuse ${replacement.name} shape changed: ` +
          `expected one unpatched block, found ${oldCount}; patched blocks: ${patchedCount}`,
      );
    }
    result = result.replace(replacement.old, replacement.patched);
  }
  return result;
}

function main(): void {
  const pluginPath = path.resolve(process.argv[2] ?? DEFAULT_PLUGIN_PATH);
  const source = fs.readFileSync(pluginPath, "utf8");
  fs.writeFileSync(pluginPath, patchLangfuseCredentials(source), "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exitCode = 1;
  }
}
