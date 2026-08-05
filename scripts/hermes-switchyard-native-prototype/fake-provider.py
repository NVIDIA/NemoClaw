#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Credential-free deterministic provider for the native Switchyard prototype."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_REQUEST_BYTES = 2 * 1024 * 1024
BOUNDED_PROMPT = (
    "Summarize this bounded status in one sentence: 0 critical, 0 high, and 2 "
    "medium findings."
)
CAPABLE_PROMPT = (
    "Design a fail-closed remediation plan for critical vulnerabilities across "
    "multiple services, including credential isolation, rollback, and end-to-end "
    "validation."
)
FAST_ANSWER = "Two medium findings remain; schedule normal remediation."
QUALITY_ANSWER = (
    "Contain affected services, isolate credentials, patch critical findings, "
    "preserve rollback, and verify the clean state end to end."
)


def message_text(message: object) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        part["text"]
        for part in content
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    )


def latest_user_prompt(body: object) -> str:
    if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
        return ""
    for message in reversed(body["messages"]):
        if isinstance(message, dict) and message.get("role") == "user":
            return message_text(message)
    return ""


def classify_prompt(prompt: str) -> str:
    if CAPABLE_PROMPT in prompt:
        return "capable"
    if BOUNDED_PROMPT in prompt:
        return "bounded"
    return "unknown"


def classifier_verdict(prompt_kind: str) -> tuple[str, str, str]:
    if prompt_kind == "capable":
        verdict = {
            "recommended_route": "capable",
            "p_solve": 0.2,
            "confidence": 0.95,
            "abstain": False,
            "capability_boundary": "uncertain",
            "primary_rule": "UNC-1",
            "crux": "multi-service fail-closed remediation with rollback",
        }
        return json.dumps(verdict, separators=(",", ":")), "strong", "risk plan"
    verdict = {
        "recommended_route": "efficient",
        "p_solve": 0.9,
        "confidence": 0.95,
        "abstain": False,
        "capability_boundary": "supported",
        "primary_rule": "SUP-1",
        "crux": "bounded deterministic summary",
    }
    return json.dumps(verdict, separators=(",", ":")), "weak", "bounded summary"


def connection_owner(connection: socket.socket) -> str | None:
    """Return the executable holding the accepted client socket on Linux."""
    peer_port = connection.getpeername()[1]
    server_port = connection.getsockname()[1]
    try:
        lines = Path("/proc/net/tcp").read_text(encoding="utf-8").splitlines()[1:]
    except OSError:
        return None
    inode = None
    for line in lines:
        fields = line.split()
        if (
            int(fields[1].split(":")[1], 16) == peer_port
            and int(fields[2].split(":")[1], 16) == server_port
            and fields[3] == "01"
        ):
            inode = fields[9]
            break
    if inode is None:
        return None
    expected = f"socket:[{inode}]"
    try:
        processes = list(Path("/proc").iterdir())
    except OSError:
        return None
    for process in processes:
        if not process.name.isdigit():
            continue
        try:
            descriptors = list((process / "fd").iterdir())
        except OSError:
            continue
        for descriptor in descriptors:
            try:
                if os.readlink(descriptor) == expected:
                    return Path(os.readlink(process / "exe")).name
            except OSError:
                continue
    return None


class Handler(BaseHTTPRequestHandler):
    log_path: Path

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.send_error(404)
            return
        encoded = b'{"status":"ok"}'
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", "0"))
        if length < 0 or length > MAX_REQUEST_BYTES:
            self.send_error(413)
            return
        encoded = self.rfile.read(length)
        try:
            body = json.loads(encoded or b"{}")
        except json.JSONDecodeError:
            self.send_error(400)
            return

        authorization_present = bool(self.headers.get("authorization"))
        model = body.get("model", "")
        prompt = latest_user_prompt(body)
        prompt_kind = classify_prompt(prompt)
        classifier_content, classifier_tier, classifier_reason = classifier_verdict(prompt_kind)
        event: dict[str, object] = {
            "accepted": self.path == "/v1/chat/completions" and not authorization_present,
            "authorization_present": authorization_present,
            "client_executable": connection_owner(self.connection),
            "model": model,
            "path": self.path,
            "prompt_kind": prompt_kind,
            "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
            "response_format_type": (body.get("response_format") or {}).get("type"),
            "stream": body.get("stream") is True,
        }
        if model == "provider/classifier":
            event.update(
                {"classifier_reason": classifier_reason, "classifier_tier": classifier_tier}
            )
            content = classifier_content
        elif model == "provider/fast":
            event.update({"selected_tier": "weak", "answer": FAST_ANSWER})
            content = FAST_ANSWER
        elif model == "provider/quality":
            event.update({"selected_tier": "strong", "answer": QUALITY_ANSWER})
            content = QUALITY_ANSWER
        else:
            content = "Unsupported native prototype target."
        with self.log_path.open("a", encoding="utf-8") as output:
            output.write(json.dumps(event, separators=(",", ":")) + "\n")

        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        if authorization_present:
            self.send_error(401)
            return
        if body.get("stream"):
            self._send_stream(model, content)
        else:
            self._send_buffered(model, content)

    def _send_stream(self, model: str, content: str) -> None:
        chunks = [
            {
                "id": "chatcmpl-native-prototype",
                "object": "chat.completion.chunk",
                "model": model,
                "system_fingerprint": "fp_nemoclaw_switchyard_native",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "content": content},
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "chatcmpl-native-prototype",
                "object": "chat.completion.chunk",
                "model": model,
                "system_fingerprint": "fp_nemoclaw_switchyard_native",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            },
        ]
        payload = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)
        encoded = f"{payload}data: [DONE]\n\n".encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _send_buffered(self, model: str, content: str) -> None:
        response = {
            "id": "chatcmpl-native-prototype",
            "object": "chat.completion",
            "model": model,
            "system_fingerprint": "fp_nemoclaw_switchyard_native",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        encoded = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class Server(ThreadingHTTPServer):
    daemon_threads = True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--port", type=int, default=4101)
    args = parser.parse_args()
    Handler.log_path = args.log
    Server(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
