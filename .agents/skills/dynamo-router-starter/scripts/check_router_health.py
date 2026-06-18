#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Smoke test a Dynamo OpenAI-compatible frontend."""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

# Tunables and contract values (kept here to avoid magic numbers in the body).
DEFAULT_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_PROMPT = "Say hello from Dynamo in one short sentence."
DEFAULT_MAX_TOKENS = 32
DEFAULT_RETRIES = 5
DEFAULT_RETRY_SLEEP_SEC = 2.0
DEFAULT_HTTP_TIMEOUT_SEC = 20.0
HTTP_OK = 200

# Process exit codes used to distinguish smoke-test outcomes.
EXIT_OK = 0
EXIT_MODELS_UNAVAILABLE = 2
EXIT_NO_MODEL_DISCOVERED = 3
EXIT_CHAT_FAILED = 4


def request_json(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    timeout: float = DEFAULT_HTTP_TIMEOUT_SEC,
) -> tuple[int, Any]:
    # Only talk to real HTTP(S) endpoints; urlopen otherwise happily opens
    # file:// and other local schemes if a bad --base-url is passed.
    scheme = urllib.parse.urlparse(url).scheme
    if scheme not in ("http", "https"):
        return 0, {"error": f"unsupported URL scheme: {scheme!r}"}
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            raw = resp.read().decode("utf-8", errors="replace")
            if not raw:
                return resp.status, None
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                # A 200 with a non-JSON body should surface as a structured
                # failure, not crash the smoke test.
                return resp.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = raw
        return exc.code, body
    except urllib.error.URLError as exc:
        return 0, {"error": str(exc.reason)}


def choose_model(models_body: Any) -> str | None:
    if not isinstance(models_body, dict):
        return None
    data = models_body.get("data")
    if isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict) and first.get("id"):
            return str(first["id"])
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--model")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    parser.add_argument("--skip-chat", action="store_true")
    parser.add_argument("--retries", type=int, default=DEFAULT_RETRIES)
    parser.add_argument("--retry-sleep", type=float, default=DEFAULT_RETRY_SLEEP_SEC)
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    result: dict[str, Any] = {"base_url": base_url, "ok": False, "checks": []}

    models_status = None
    models_body = None
    for attempt in range(1, args.retries + 1):
        models_status, models_body = request_json("GET", f"{base_url}/v1/models")
        if models_status == HTTP_OK:
            break
        time.sleep(args.retry_sleep)

    model = args.model or choose_model(models_body)
    result["checks"].append(
        {"name": "models", "status": models_status, "body": models_body, "model": model}
    )

    if models_status != HTTP_OK:
        print(json.dumps(result, indent=2))
        return EXIT_MODELS_UNAVAILABLE

    if args.skip_chat:
        result["ok"] = True
        print(json.dumps(result, indent=2))
        return EXIT_OK

    if not model:
        result["checks"].append(
            {"name": "chat", "status": "skipped", "reason": "No model discovered"}
        )
        print(json.dumps(result, indent=2))
        return EXIT_NO_MODEL_DISCOVERED

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": args.prompt}],
        "max_tokens": args.max_tokens,
    }
    chat_status, chat_body = request_json(
        "POST", f"{base_url}/v1/chat/completions", payload
    )
    result["checks"].append({"name": "chat", "status": chat_status, "body": chat_body})
    result["ok"] = chat_status == HTTP_OK
    print(json.dumps(result, indent=2))
    return EXIT_OK if result["ok"] else EXIT_CHAT_FAILED


if __name__ == "__main__":
    sys.exit(main())
