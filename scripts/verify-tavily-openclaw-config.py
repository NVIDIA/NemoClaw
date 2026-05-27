#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate openclaw.json Tavily web search shape (no legacy tools.web.search.tavily)."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "~/.openclaw/openclaw.json").expanduser()
    cfg = json.loads(path.read_text(encoding="utf-8"))
    search = cfg.get("tools", {}).get("web", {}).get("search", {})
    if not isinstance(search, dict):
        print(f"FAIL: missing tools.web.search in {path}", file=sys.stderr)
        return 1
    if search.get("provider") != "tavily":
        print(f"FAIL: expected provider=tavily, got {search.get('provider')!r}", file=sys.stderr)
        return 1
    if "tavily" in search:
        print(
            "FAIL: legacy tools.web.search.tavily is present — rebuild with updated "
            "generate-openclaw-config.py",
            file=sys.stderr,
        )
        return 1
    tavily = cfg.get("plugins", {}).get("entries", {}).get("tavily")
    if not isinstance(tavily, dict) or not tavily.get("enabled"):
        print("FAIL: plugins.entries.tavily must be enabled", file=sys.stderr)
        return 1
    web_search = (tavily.get("config") or {}).get("webSearch")
    if not isinstance(web_search, dict) or not web_search.get("apiKey"):
        print("FAIL: plugins.entries.tavily.config.webSearch.apiKey missing", file=sys.stderr)
        return 1
    print(f"OK: Tavily config valid in {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
