#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Keep pinned Hermes MCP HTTP transports on the managed egress proxy.

Hermes v0.21.3 wraps a caller-owned ``httpx.AsyncHTTPTransport`` to enforce
the MCP response-body limit. Supplying that transport disables httpx's normal
environment-proxy discovery, so Streamable HTTP and SSE sessions bypass
``HTTPS_PROXY`` even though Hermes' preliminary HTTP client honors it. In an
OpenShell sandbox the bypass cannot reach the configured server and also
misses policy enforcement and credential rewriting.

Patch both caller-owned MCP transports to let the pinned httpx client build its
standard environment proxy mounts, then wrap the direct transport and every
proxy mount with the existing body cap. This preserves exact ``NO_PROXY`` and
redirect routing instead of selecting one proxy for the initial URL. The exact
source-shape checks fail closed when the pinned Hermes transport changes.

Remove this patch when the minimum supported Hermes release passes an
environment-selected proxy into its caller-owned MCP HTTP transports.
"""

from __future__ import annotations

import argparse
from pathlib import Path

OLD_HELPER_ANCHOR = '''def _present(**kwargs) -> dict:
    """*kwargs* minus the ``None`` values (optional httpx client arguments)."""
    return {k: v for k, v in kwargs.items() if v is not None}
'''

NEW_HELPER_BLOCK = '''

def _body_capped_httpx_client(httpx_module, **kwargs):
    """Build a proxy-aware client and retain the MCP body cap on every route."""
    client = httpx_module.AsyncClient(trust_env=True, **kwargs)
    client._transport = _make_mcp_body_cap_transport(httpx_module, client._transport)
    client._mounts = {
        pattern: (
            None
            if transport is None
            else _make_mcp_body_cap_transport(httpx_module, transport)
        )
        for pattern, transport in client._mounts.items()
    }
    return client
'''

OLD_SSE_FACTORY = '''sse_kwargs["httpx_client_factory"] = lambda headers=None, timeout=None, auth=None: _httpx_mod.AsyncClient(
            follow_redirects=True,
            timeout=timeout if timeout is not None else _httpx_mod.Timeout(30.0, read=300.0),
            transport=_make_mcp_body_cap_transport(
                _httpx_mod, _httpx_mod.AsyncHTTPTransport(verify=ssl_verify, **_present(cert=client_cert))),
            **_present(headers=headers, auth=auth))'''
NEW_SSE_FACTORY = '''sse_kwargs["httpx_client_factory"] = lambda headers=None, timeout=None, auth=None: _body_capped_httpx_client(
            _httpx_mod,
            follow_redirects=True,
            timeout=timeout if timeout is not None else _httpx_mod.Timeout(30.0, read=300.0),
            verify=ssl_verify,
            **_present(cert=client_cert, headers=headers, auth=auth))'''

OLD_STREAMABLE_CLIENT = '''client_kwargs: dict = {"follow_redirects": True, "timeout": httpx.Timeout(float(connect_timeout), read=300.0),
                               **({"headers": headers} if headers else {}),
                               "event_hooks": {"response": [_strip_auth_on_cross_origin_redirect]},
                               "transport": _make_mcp_body_cap_transport(
                                   httpx, httpx.AsyncHTTPTransport(verify=ssl_verify, **_present(cert=client_cert))),
                               **_present(auth=oauth_auth)}'''
NEW_STREAMABLE_CLIENT = '''client_kwargs: dict = {"follow_redirects": True, "timeout": httpx.Timeout(float(connect_timeout), read=300.0),
                               **({"headers": headers} if headers else {}),
                               "event_hooks": {"response": [_strip_auth_on_cross_origin_redirect]},
                               "verify": ssl_verify,
                               **_present(cert=client_cert, auth=oauth_auth)}'''

OLD_OWNED_CLIENT = '''async with httpx.AsyncClient(**client_kwargs) as http_client:'''
NEW_OWNED_CLIENT = '''async with _body_capped_httpx_client(httpx, **client_kwargs) as http_client:'''


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    transport_replacements = (
        ("SSE client factory", OLD_SSE_FACTORY, NEW_SSE_FACTORY),
        ("Streamable HTTP client config", OLD_STREAMABLE_CLIENT, NEW_STREAMABLE_CLIENT),
        ("Streamable HTTP client construction", OLD_OWNED_CLIENT, NEW_OWNED_CLIENT),
    )

    if source.count(NEW_HELPER_BLOCK) == 1 and all(
        source.count(old) == 0 and source.count(new) == 1
        for _, old, new in transport_replacements
    ):
        return

    if source.count(OLD_HELPER_ANCHOR) != 1 or source.count(NEW_HELPER_BLOCK) != 0:
        raise SystemExit(
            "ERROR: Hermes MCP HTTP proxy source shape changed; "
            f"expected one helper anchor, found {source.count(OLD_HELPER_ANCHOR)} "
            f"(already patched helpers: {source.count(NEW_HELPER_BLOCK)})"
        )

    for label, old, new in transport_replacements:
        old_count = source.count(old)
        new_count = source.count(new)
        if old_count != 1 or new_count != 0:
            raise SystemExit(
                "ERROR: Hermes MCP HTTP proxy source shape changed; "
                f"expected one unpatched {label}, found {old_count} "
                f"(already patched shapes: {new_count})"
            )

    source = source.replace(OLD_HELPER_ANCHOR, OLD_HELPER_ANCHOR + NEW_HELPER_BLOCK)
    for _, old, new in transport_replacements:
        source = source.replace(old, new)
    path.write_text(source, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        default="/opt/hermes/tools/mcp_tool_transport.py",
        help="Hermes MCP transport module to patch",
    )
    args = parser.parse_args()
    patch_file(Path(args.path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
