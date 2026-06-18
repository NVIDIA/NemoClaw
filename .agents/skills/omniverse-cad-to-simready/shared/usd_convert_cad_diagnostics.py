#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse


DOWNLOAD_RE = re.compile(r"Failed to download:\s*['\"](?P<url>https?://[^'\"]+)['\"]")
EXTENSION_RE = re.compile(
    r"(?:Pulling extension:\s*`|Failed to pull extension:\s*['\"])(?P<extension>[^`'\"]+)"
)
CACHE_RE = re.compile(r"Failed to pull extension:\s*['\"][^'\"]+['\"]\s+in\s+['\"](?P<cache>[^'\"]+)['\"]")
RESULT_RE = re.compile(r"\b(?P<result>Result\.[A-Z0-9_]+)\b")
KIT_LOG_RE = re.compile(r"Logging to file:\s*(?P<path>\S.+)")


def summarize_usd_convert_cad_validation_failure(output: str, exit_code: int | None) -> dict[str, Any] | None:
    """Return a structured diagnostic for known upstream Kit registry failures."""
    text = output or ""
    if not text:
        return None

    download_url = _first_match(DOWNLOAD_RE, text, "url")
    extension = _last_match(EXTENSION_RE, text, "extension")
    result = _first_match(RESULT_RE, text, "result")
    has_access_denied = result == "Result.ERROR_ACCESS_DENIED" or "Result.ERROR_ACCESS_DENIED" in text
    has_kit_download = bool(download_url and (extension or "Failed to pull extension" in text))
    if not has_access_denied and not has_kit_download:
        return None

    url_host = urlparse(download_url).netloc if download_url else ""
    kind = "kit_registry_access_denied" if has_access_denied else "kit_registry_download_failure"
    action = "access denied" if kind == "kit_registry_access_denied" else "download failed"
    target = f" while fetching {extension}" if extension else ""
    source = f" from {url_host}" if url_host else ""
    summary = f"Kit extension registry {action}{target}{source}."
    recovery_hint = (
        "Verify the Horde host can reach the Kit extension registry/CDN with the required network, "
        "proxy, or credentials, or pre-populate and reuse the upstream usd-convert-cad Kit extension "
        "cache; then rerun `OMNI_KIT_ACCEPT_EULA=yes python validate.py` in the upstream checkout."
    )

    diagnostic: dict[str, Any] = {
        "kind": kind,
        "summary": summary,
        "recovery_hint": recovery_hint,
    }
    if exit_code is not None:
        diagnostic["exit_code"] = exit_code
    if result:
        diagnostic["result"] = result
    if extension:
        diagnostic["extension"] = extension
    if download_url:
        diagnostic["download_url"] = download_url
    if url_host:
        diagnostic["url_host"] = url_host
    cache_path = _last_match(CACHE_RE, text, "cache")
    if cache_path:
        diagnostic["cache_path"] = cache_path
    kit_log_path = _last_match(KIT_LOG_RE, text, "path")
    if kit_log_path:
        diagnostic["kit_log_path"] = kit_log_path.strip()
    return diagnostic


def _first_match(pattern: re.Pattern[str], text: str, group: str) -> str:
    match = pattern.search(text)
    return match.group(group).strip() if match else ""


def _last_match(pattern: re.Pattern[str], text: str, group: str) -> str:
    matches = list(pattern.finditer(text))
    return matches[-1].group(group).strip() if matches else ""
