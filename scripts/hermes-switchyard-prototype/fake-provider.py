#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Deterministic loopback-only provider for the Hermes Switchyard prototype."""

from __future__ import annotations

import argparse
import hmac
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
    parts: list[str] = []
    for part in content:
        if isinstance(part, dict) and isinstance(part.get("text"), str):
            parts.append(part["text"])
    return "\n".join(parts)


def latest_user_prompt(body: object) -> str:
    if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
        return ""
    for message in reversed(body["messages"]):
        if isinstance(message, dict) and message.get("role") == "user":
            return message_text(message)
    return ""


def demo_turn(prompt: str) -> str:
    if prompt == BOUNDED_PROMPT:
        return "bounded-summary"
    if prompt == CAPABLE_PROMPT:
        return "risk-remediation"
    return "unrecognized"


def classifier_verdict(prompt: str) -> tuple[str, str, str]:
    if prompt == CAPABLE_PROMPT:
        verdict = {
            "recommended_route": "capable",
            "p_solve": 0.2,
            "confidence": 0.95,
            "abstain": False,
            "capability_boundary": "uncertain",
            "primary_rule": "UNC-1",
            "crux": "multi-service fail-closed remediation with rollback",
        }
        return (
            json.dumps(verdict, separators=(",", ":")),
            "strong",
            "higher-risk multi-service plan requires the capable tier",
        )
    verdict = {
        "recommended_route": "efficient",
        "p_solve": 0.9,
        "confidence": 0.95,
        "abstain": False,
        "capability_boundary": "supported",
        "primary_rule": "SUP-1",
        "crux": "bounded deterministic summary",
    }
    return (
        json.dumps(verdict, separators=(",", ":")),
        "weak",
        "bounded summary is suitable for the efficient tier",
    )


def executable_names() -> set[str]:
    names: set[str] = set()
    try:
        processes = list(Path("/proc").iterdir())
    except OSError:
        return names
    for process in processes:
        if not process.name.isdigit():
            continue
        try:
            names.add(Path(os.readlink(process / "exe")).name)
        except OSError:
            continue
    return names


def connection_owner(connection: socket.socket) -> str | None:
    peer_port = connection.getpeername()[1]
    server_port = connection.getsockname()[1]
    socket_inode: str | None = None
    try:
        lines = Path("/proc/net/tcp").read_text(encoding="utf-8").splitlines()[1:]
    except OSError:
        return None
    for line in lines:
        fields = line.split()
        local_port = int(fields[1].split(":")[1], 16)
        remote_port = int(fields[2].split(":")[1], 16)
        if local_port == peer_port and remote_port == server_port and fields[3] == "01":
            socket_inode = fields[9]
            break
    if socket_inode is None:
        return None

    expected_link = f"socket:[{socket_inode}]"
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
                if os.readlink(descriptor) == expected_link:
                    return Path(os.readlink(process / "exe")).name
            except OSError:
                continue
    return None


class Handler(BaseHTTPRequestHandler):
    expected_authorization: str
    log_path: Path

    def do_POST(self) -> None:  # noqa: N802
        authorization = self.headers.get("authorization", "")
        authorization_matches = hmac.compare_digest(
            authorization, self.expected_authorization
        )
        length = int(self.headers.get("content-length", "0"))
        if length < 0 or length > MAX_REQUEST_BYTES:
            self._log_attempt(
                {
                    "accepted": False,
                    "authorization_matches": authorization_matches,
                    "body_oversized": True,
                    "path": self.path,
                }
            )
            self.send_error(413)
            return
        encoded_body = self.rfile.read(length)
        try:
            body = json.loads(encoded_body or b"{}")
        except json.JSONDecodeError:
            self._log_attempt(
                {
                    "accepted": False,
                    "authorization_matches": authorization_matches,
                    "body_invalid": True,
                    "path": self.path,
                }
            )
            self.send_error(400)
            return

        non_authorization_headers = "\n".join(
            value
            for name, value in self.headers.items()
            if name.lower() != "authorization"
        )
        unexpected_credential_seen = any(
            sentinel.encode() in encoded_body
            or sentinel in non_authorization_headers
            for sentinel in (
                "nemoclaw-prototype-client-sentinel",
                "nemoclaw-prototype-provider-sentinel",
                "Bearer nemoclaw-prototype-provider-sentinel",
            )
        )
        model = body.get("model", "fake-model")
        prompt = latest_user_prompt(body)
        turn = demo_turn(prompt)
        classifier_content, classifier_tier, classifier_reason = classifier_verdict(
            prompt
        )
        process_names = executable_names()
        accepted = (
            self.path == "/v1/chat/completions"
            and authorization_matches
            and not unexpected_credential_seen
        )
        event = {
            "accepted": accepted,
            "authorization_matches": authorization_matches,
            "client_executable": connection_owner(self.connection),
            "demo_turn": turn,
            "model": model,
            "path": self.path,
            "response_format_type": (body.get("response_format") or {}).get("type"),
            "stream": body.get("stream") is True,
            "switchyard_server_seen": "switchyard-server" in process_names,
            "unexpected_credential_seen": unexpected_credential_seen,
        }
        if model == "provider/classifier":
            event.update(
                {
                    "classifier_reason": classifier_reason,
                    "classifier_tier": classifier_tier,
                }
            )
        elif model == "provider/fast":
            event.update({"demo_answer": FAST_ANSWER, "selected_tier": "weak"})
        elif model == "provider/quality":
            event.update({"demo_answer": QUALITY_ANSWER, "selected_tier": "strong"})
        self._log_attempt(event)
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        if not authorization_matches or unexpected_credential_seen:
            self.send_error(401)
            return

        if model == "provider/classifier":
            content = classifier_content
        elif model == "provider/fast":
            content = FAST_ANSWER
        elif model == "provider/quality":
            content = QUALITY_ANSWER
        else:
            content = "Unsupported prototype target."
        if body.get("stream"):
            self._send_stream(model, content)
        else:
            self._send_buffered(model, content)

    def _log_attempt(self, event: dict[str, object]) -> None:
        with self.log_path.open("a", encoding="utf-8") as output:
            output.write(json.dumps(event, separators=(",", ":")) + "\n")

    def _send_stream(self, model: str, content: str) -> None:
        chunks = [
            {
                "id": "chatcmpl-prototype",
                "object": "chat.completion.chunk",
                "model": model,
                "system_fingerprint": "fp_nemoclaw_switchyard_prototype",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "content": content},
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "chatcmpl-prototype",
                "object": "chat.completion.chunk",
                "model": model,
                "system_fingerprint": "fp_nemoclaw_switchyard_prototype",
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
            "id": "chatcmpl-prototype",
            "object": "chat.completion",
            "model": model,
            "system_fingerprint": "fp_nemoclaw_switchyard_prototype",
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
    Handler.expected_authorization = os.environ["PROTOTYPE_PROVIDER_AUTHORIZATION"]
    Handler.log_path = args.log
    Server(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
