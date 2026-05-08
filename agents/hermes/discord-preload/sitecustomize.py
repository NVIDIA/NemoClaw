# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Redirect discord.py Discord transports to NemoClaw's local facade."""

from __future__ import annotations

import os
from urllib.parse import ParseResult, parse_qsl, urlencode, urlparse, urlunparse


FACADE_URL = os.getenv("NEMOCLAW_DISCORD_FACADE_URL", "").strip()
if FACADE_URL:
    try:
        import aiohttp
    except Exception:
        aiohttp = None

    if aiohttp is not None:
        _facade = urlparse(FACADE_URL)
        _original_request = aiohttp.ClientSession._request
        _original_ws_connect = aiohttp.ClientSession.ws_connect
        _api_hosts = {"discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"}
        _gateway_hosts = {"gateway.discord.gg"}

        def _replace_netloc(parsed: ParseResult, *, scheme: str, path: str) -> str:
            return urlunparse((scheme, _facade.netloc, path, "", parsed.query, ""))

        def _rewrite_rest_url(url: object) -> str | None:
            parsed = urlparse(str(url))
            if parsed.hostname not in _api_hosts:
                return None
            if not parsed.path.startswith("/api"):
                return None
            return _replace_netloc(parsed, scheme=_facade.scheme or "http", path=parsed.path)

        def _rewrite_gateway_url(url: object) -> str | None:
            parsed = urlparse(str(url))
            hostname = parsed.hostname or ""
            if hostname not in _gateway_hosts and not hostname.endswith(".discord.gg"):
                return None
            query = dict(parse_qsl(parsed.query, keep_blank_values=True))
            if "v" not in query:
                query["v"] = "10"
            rewritten_query = urlencode(query)
            scheme = "wss" if (_facade.scheme == "https") else "ws"
            return urlunparse((scheme, _facade.netloc, "/gateway", "", rewritten_query, ""))

        def _is_facade_url(url: object) -> bool:
            try:
                return urlparse(str(url)).netloc == _facade.netloc
            except Exception:
                return False

        async def _nemoclaw_request(self, method, str_or_url, **kwargs):
            rewritten = _rewrite_rest_url(str_or_url)
            if rewritten:
                kwargs.pop("proxy", None)
                kwargs.pop("proxy_auth", None)
                kwargs.pop("ssl", None)
                str_or_url = rewritten
            elif _is_facade_url(str_or_url):
                kwargs.pop("proxy", None)
                kwargs.pop("proxy_auth", None)
                kwargs.pop("ssl", None)
            return await _original_request(self, method, str_or_url, **kwargs)

        def _nemoclaw_ws_connect(self, url, **kwargs):
            rewritten = _rewrite_gateway_url(url)
            if rewritten:
                kwargs.pop("proxy", None)
                kwargs.pop("proxy_auth", None)
                kwargs.pop("ssl", None)
                url = rewritten
            elif _is_facade_url(url):
                kwargs.pop("proxy", None)
                kwargs.pop("proxy_auth", None)
                kwargs.pop("ssl", None)
            return _original_ws_connect(self, url, **kwargs)

        aiohttp.ClientSession._request = _nemoclaw_request
        aiohttp.ClientSession.ws_connect = _nemoclaw_ws_connect
