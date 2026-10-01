#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# mock_tool — CLI stand-in for the OpenWebUI browser_shell Tool (Plan §7).
# POSTs a command to the relay's /api/cmd exactly like the tool does, useful
# for manual testing / M1 acceptance.
#
#   python3 mock_browser.py --chat t1 &
#   python3 mock_tool.py   --chat t1 --cmd "uname -a" --key test-key

import argparse
import json
import urllib.request
import urllib.error


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8787")
    ap.add_argument("--chat", required=True)
    ap.add_argument("--cmd", default="ls -la")
    ap.add_argument("--cwd", default="/root")
    ap.add_argument("--timeout-ms", type=int, default=30000)
    ap.add_argument("--key", default="")
    args = ap.parse_args()

    payload = json.dumps(
        {
            "chat_id": args.chat,
            "command": args.cmd,
            "cwd": args.cwd,
            "timeout_ms": args.timeout_ms,
        }
    ).encode()
    req = urllib.request.Request(
        f"{args.url.rstrip('/')}/api/cmd",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    if args.key:
        req.add_header("Authorization", f"Bearer {args.key}")
    try:
        with urllib.request.urlopen(req, timeout=(args.timeout_ms / 1000.0) + 15) as resp:
            print(resp.status, json.dumps(json.loads(resp.read()), indent=2))
    except urllib.error.HTTPError as e:
        print(e.code, e.read().decode())
    except Exception as e:  # noqa: BLE001
        print("error:", e)


if __name__ == "__main__":
    main()