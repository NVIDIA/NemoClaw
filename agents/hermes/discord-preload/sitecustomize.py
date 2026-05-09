# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Patch Hermes Python transports for NemoClaw-managed messaging egress."""

from __future__ import annotations

import os
import re
import urllib.request
from urllib.parse import ParseResult, parse_qsl, urlencode, urlparse, urlunparse


SLACK_PLACEHOLDER_RE = re.compile(
    r"\b(?:xoxb|xapp)-OPENSHELL-RESOLVE-ENV-(SLACK_(?:BOT|APP)_TOKEN)\b"
)
SLACK_FAST_PATH = "OPENSHELL-RESOLVE-ENV-SLACK_"


def _rewrite_slack_string(value: str) -> str:
    if SLACK_FAST_PATH not in value:
        return value
    return SLACK_PLACEHOLDER_RE.sub(r"openshell:resolve:env:\1", value)


def _rewrite_slack_value(value):
    if isinstance(value, str):
        return _rewrite_slack_string(value)
    if isinstance(value, bytes):
        if SLACK_FAST_PATH.encode("ascii") not in value:
            return value
        try:
            return _rewrite_slack_string(value.decode("utf-8")).encode("utf-8")
        except UnicodeDecodeError:
            return value
    if isinstance(value, bytearray):
        as_bytes = bytes(value)
        rewritten = _rewrite_slack_value(as_bytes)
        return bytearray(rewritten) if rewritten != as_bytes else value
    if isinstance(value, tuple):
        return tuple(_rewrite_slack_value(item) for item in value)
    if isinstance(value, list):
        return [_rewrite_slack_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _rewrite_slack_value(item) for key, item in value.items()}
    return value


def _rewrite_slack_headers(headers):
    if not headers:
        return headers
    if isinstance(headers, dict):
        for key in list(headers.keys()):
            headers[key] = _rewrite_slack_value(headers[key])
        return headers
    if hasattr(headers, "items") and hasattr(headers, "__setitem__"):
        try:
            for key, value in list(headers.items()):
                headers[key] = _rewrite_slack_value(value)
            return headers
        except (AttributeError, KeyError, TypeError):
            pass
    if isinstance(headers, (list, tuple)):
        return type(headers)((key, _rewrite_slack_value(value)) for key, value in headers)
    return headers


def _rewrite_slack_url(url):
    if not isinstance(url, str):
        text = str(url)
        rewritten = _rewrite_slack_string(text)
        return rewritten if rewritten != text else url
    return _rewrite_slack_string(url)


def _rewrite_slack_kwargs(kwargs):
    if "headers" in kwargs:
        kwargs["headers"] = _rewrite_slack_headers(kwargs["headers"])
    for key in ("data", "json", "params", "content"):
        if key in kwargs:
            kwargs[key] = _rewrite_slack_value(kwargs[key])
    return kwargs


try:
    import aiohttp
except Exception:
    aiohttp = None


_original_urllib_request_init = urllib.request.Request.__init__
_original_urllib_add_header = urllib.request.Request.add_header
_original_urllib_add_unredirected_header = urllib.request.Request.add_unredirected_header


def _nemoclaw_urllib_request_init(
    self,
    url,
    data=None,
    headers=None,
    origin_req_host=None,
    unverifiable=False,
    method=None,
):
    headers = {} if headers is None else headers
    return _original_urllib_request_init(
        self,
        _rewrite_slack_url(url),
        data=_rewrite_slack_value(data),
        headers=_rewrite_slack_headers(headers),
        origin_req_host=origin_req_host,
        unverifiable=unverifiable,
        method=method,
    )


def _nemoclaw_urllib_add_header(self, key, val):
    return _original_urllib_add_header(self, key, _rewrite_slack_value(val))


def _nemoclaw_urllib_add_unredirected_header(self, key, val):
    return _original_urllib_add_unredirected_header(self, key, _rewrite_slack_value(val))


urllib.request.Request.__init__ = _nemoclaw_urllib_request_init
urllib.request.Request.add_header = _nemoclaw_urllib_add_header
urllib.request.Request.add_unredirected_header = _nemoclaw_urllib_add_unredirected_header


try:
    import requests.sessions as _requests_sessions
except Exception:
    _requests_sessions = None

if _requests_sessions is not None:
    _original_requests_request = _requests_sessions.Session.request

    def _nemoclaw_requests_request(self, method, url, **kwargs):
        return _original_requests_request(
            self, method, _rewrite_slack_url(url), **_rewrite_slack_kwargs(kwargs)
        )

    _requests_sessions.Session.request = _nemoclaw_requests_request


try:
    import httpx as _httpx
except Exception:
    _httpx = None

if _httpx is not None:
    _original_httpx_client_request = _httpx.Client.request
    _original_httpx_async_client_request = _httpx.AsyncClient.request

    def _nemoclaw_httpx_client_request(self, method, url, *args, **kwargs):
        return _original_httpx_client_request(
            self, method, _rewrite_slack_url(url), *args, **_rewrite_slack_kwargs(kwargs)
        )

    async def _nemoclaw_httpx_async_client_request(self, method, url, *args, **kwargs):
        return await _original_httpx_async_client_request(
            self, method, _rewrite_slack_url(url), *args, **_rewrite_slack_kwargs(kwargs)
        )

    _httpx.Client.request = _nemoclaw_httpx_client_request
    _httpx.AsyncClient.request = _nemoclaw_httpx_async_client_request


FACADE_URL = os.getenv("NEMOCLAW_DISCORD_FACADE_URL", "").strip()
if aiohttp is not None:
    _original_request = aiohttp.ClientSession._request

    if FACADE_URL:
        _facade = urlparse(FACADE_URL)
        _original_ws_connect = aiohttp.ClientSession.ws_connect
    else:
        _facade = None

    _api_hosts = {"discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"}
    _gateway_hosts = {"gateway.discord.gg"}

    def _replace_netloc(parsed: ParseResult, *, scheme: str, path: str) -> str:
        if _facade is None:
            return str(parsed)
        return urlunparse((scheme, _facade.netloc, path, "", parsed.query, ""))

    def _rewrite_rest_url(url: object) -> str | None:
        if _facade is None:
            return None
        parsed = urlparse(str(url))
        if parsed.hostname not in _api_hosts:
            return None
        if not parsed.path.startswith("/api"):
            return None
        return _replace_netloc(parsed, scheme=_facade.scheme or "http", path=parsed.path)

    def _rewrite_gateway_url(url: object) -> str | None:
        if _facade is None:
            return None
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
        if _facade is None:
            return False
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
        str_or_url = _rewrite_slack_url(str_or_url)
        return await _original_request(self, method, str_or_url, **_rewrite_slack_kwargs(kwargs))

    aiohttp.ClientSession._request = _nemoclaw_request

    if FACADE_URL:
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

        aiohttp.ClientSession.ws_connect = _nemoclaw_ws_connect
