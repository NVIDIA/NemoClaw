# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import json
import os
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Tavily:
    name = "tavily"

    def is_available(self):
        return bool(os.environ.get("TAVILY_API_KEY"))

    def supports_extract(self):
        return True

    def _request(self, path, body):
        key = os.environ.get("TAVILY_API_KEY")
        if not key:
            raise ValueError("TAVILY_API_KEY is unavailable")
        request = urllib.request.Request(
            "https://api.tavily.com" + path,
            data=json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    raise ValueError("Tavily response exceeds limit")
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            raise ValueError(f"Tavily request failed with HTTP {error.code}") from None
        except (OSError, ValueError):
            raise ValueError("Tavily request failed or returned an invalid response") from None

    def search(self, query, limit=5):
        try:
            response = self._request("/search", {"query": query, "max_results": limit})
            return {
                "success": True,
                "data": {
                    "web": [
                        {
                            "title": item["title"],
                            "url": item["url"],
                            "description": item["content"],
                            "position": index,
                        }
                        for index, item in enumerate(response["results"], 1)
                    ]
                },
            }
        except (ValueError, KeyError, TypeError):
            return {"success": False, "error": "Tavily search failed"}

    def extract(self, urls, **kwargs):
        try:
            response = self._request("/extract", {"urls": urls})
            return [
                {
                    "url": item["url"],
                    "title": item.get("title", item["url"]),
                    "content": item["raw_content"],
                    "raw_content": item["raw_content"],
                }
                for item in response["results"]
            ] + [
                {"url": item["url"], "error": "Tavily could not extract this URL"}
                for item in response.get("failed_results", [])
            ]
        except (ValueError, KeyError, TypeError):
            return [{"url": url, "error": "Tavily extraction failed"} for url in urls]


def register(ctx):
    from agent.web_search_provider import WebSearchProvider

    class TavilyWebSearchProvider(Tavily, WebSearchProvider):
        pass

    ctx.register_web_search_provider(TavilyWebSearchProvider())
