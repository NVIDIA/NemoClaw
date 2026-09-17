# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Expose the declared Brave integration through Fabric's native MCP tool support."""

import json
import os


def web_search(query: str, count: int = 5) -> dict:
    """Search the web for current information and return Brave's results."""
    if not query.strip() or len(query) > 2048 or type(count) is not int or not 1 <= count <= 10:
        raise ValueError("search requires a nonempty query and count between 1 and 10")
    import httpx

    try:
        with httpx.stream(
            "GET",
            "https://api.search.brave.com/res/v1/web/search",
            params={"q": query, "count": count},
            headers={
                "X-Subscription-Token": os.environ["BRAVE_API_KEY"],
                "Accept": "application/json",
            },
            timeout=20,
            follow_redirects=False,
        ) as response:
            response.raise_for_status()
            body = bytearray()
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > 1024 * 1024:
                    raise ValueError("search response exceeds limit")
            result = json.loads(body)
            if not isinstance(result, dict):
                raise ValueError("invalid search response")
            return result
    except Exception:
        raise RuntimeError(
            "Brave search failed; check the integration credential and service"
        ) from None


if __name__ == "__main__":
    from mcp.server.fastmcp import FastMCP

    server = FastMCP("nemoclaw-brave")
    server.tool()(web_search)
    server.run()
