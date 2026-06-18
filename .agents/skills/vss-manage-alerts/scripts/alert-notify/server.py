# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Alert Notify - multi-backend webhook server.

Receives VSS incident webhooks and fans them out to one or more configured
notification backends. Backends are selected via the `NOTIFY_BACKENDS` env
var (comma-separated, e.g. `slack`, `dashboard`, or `slack,dashboard`).
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request

from incident_utils import safe_get
from notifier_base import NotifierBase, NotifierResult

load_dotenv(Path(__file__).parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("alert-notify")

VST_ENDPOINT: str | None = None
VST_PUBLIC_URL_BASE: str | None = None  # e.g. https://7777-xbrxpi7ia.brevlab.com
_http_client: httpx.AsyncClient | None = None
_backends: list[NotifierBase] = []
_start_time: float = 0.0
_notification_count: int = 0


# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------

def _parse_backend_names() -> list[str]:
    raw = os.environ.get("NOTIFY_BACKENDS", "dashboard")
    names = [n.strip().lower() for n in raw.split(",") if n.strip()]
    if not names:
        raise RuntimeError("NOTIFY_BACKENDS must list at least one backend")

    seen: set[str] = set()
    unique: list[str] = []
    for name in names:
        if name not in seen:
            seen.add(name)
            unique.append(name)
    return unique


def _build_backend(name: str) -> NotifierBase:
    if name == "slack":
        from slack_notifier import SlackNotifier
        return SlackNotifier()
    if name == "dashboard":
        from open_claw_dashboard_notifier import DashboardNotifier
        return DashboardNotifier()
    raise RuntimeError(f"Unknown backend '{name}' (expected: slack, dashboard)")


# ---------------------------------------------------------------------------
# Shared VST stream resolution
# ---------------------------------------------------------------------------

_sensor_cache: dict[str, str] = {}


def _pick_stream_id(streams: list[dict], fallback: str) -> str:
    for s in streams:
        if s.get("isMain"):
            return s.get("streamId", fallback)
    return streams[0].get("streamId", fallback) if streams else fallback


async def _resolve_stream_id(sensor_ref: str) -> str | None:
    """Resolve a sensor name or sensorId to a real VST streamId (UUID).

    Strategy:
    1. If sensor_ref is already a UUID sensorId, /sensor/{id}/streams returns 200.
    2. Otherwise, /sensor/list to match by sensorId or name -> /sensor/{id}/streams.
    Results are cached in-process.
    """
    if sensor_ref in _sensor_cache:
        return _sensor_cache[sensor_ref]

    if not _http_client or not VST_ENDPOINT:
        return None

    base = f"http://{VST_ENDPOINT}/vst/api/v1"

    try:
        resp = await _http_client.get(f"{base}/sensor/{sensor_ref}/streams")
        if resp.status_code == 200:
            streams = resp.json()
            if isinstance(streams, list) and streams:
                sid = _pick_stream_id(streams, sensor_ref)
                _sensor_cache[sensor_ref] = sid
                return sid
    except Exception:
        pass

    try:
        resp = await _http_client.get(f"{base}/sensor/list")
        resp.raise_for_status()
        real_sensor_id = None
        for sensor in resp.json():
            if sensor.get("sensorId") == sensor_ref or sensor.get("name") == sensor_ref:
                real_sensor_id = sensor["sensorId"]
                break
        if not real_sensor_id:
            logger.warning("Sensor '%s' not found in VST sensor list", sensor_ref)
            return None
    except Exception as exc:
        logger.warning("Failed to fetch sensor list from VST: %s", exc)
        return None

    try:
        resp = await _http_client.get(f"{base}/sensor/{real_sensor_id}/streams")
        resp.raise_for_status()
        streams = resp.json()
        if isinstance(streams, list) and streams:
            sid = _pick_stream_id(streams, real_sensor_id)
            _sensor_cache[sensor_ref] = sid
            return sid
    except Exception as exc:
        logger.warning("Failed to get streams for sensor %s: %s", real_sensor_id, exc)

    _sensor_cache[sensor_ref] = real_sensor_id
    return real_sensor_id


def _rewrite_to_public(video_url: str) -> str:
    """If VST_PUBLIC_URL_BASE is set, swap the scheme+host:port of video_url for it.

    Path, query, params, and fragment are preserved verbatim. No-op if either
    input is empty or VST_PUBLIC_URL_BASE is unset.
    """
    if not video_url or not VST_PUBLIC_URL_BASE:
        return video_url
    parsed = urlparse(video_url)
    base = urlparse(VST_PUBLIC_URL_BASE)
    return urlunparse((
        base.scheme, base.netloc, parsed.path,
        parsed.params, parsed.query, parsed.fragment,
    ))


async def _resolve_video_url(
    stream_id: str,
    start_time: str,
    end_time: str,
) -> str | None:
    """Fetch a temporary video clip URL from VST.

    stream_id may be a sensor name - it will be resolved to a real UUID first.
    Timestamps are passed through to VST verbatim.
    """
    if not VST_ENDPOINT or not _http_client:
        return None

    resolved_id = await _resolve_stream_id(stream_id)
    if not resolved_id:
        return None

    logger.info(
        "Resolving video URL: input=%s, resolved_stream=%s, startTime=%s, endTime=%s",
        stream_id, resolved_id, start_time, end_time,
    )

    url = (
        f"http://{VST_ENDPOINT}/vst/api/v1/storage/file/{resolved_id}/url"
        f"?startTime={start_time}&endTime={end_time}"
        f"&container=mp4&disableAudio=true&expiryMinutes=10080"
    )
    try:
        resp = await _http_client.get(url)
        resp.raise_for_status()
        video_url = resp.json().get("videoUrl")
        video_url = _rewrite_to_public(video_url)
        if video_url:
            logger.info("Resolved video URL from VST for stream %s", resolved_id)
            return video_url
    except Exception as exc:
        logger.warning("Failed to resolve video URL from VST (stream=%s): %s", resolved_id, exc)
    return None


async def _enrich_incident_with_video(incident: dict) -> None:
    """Mutates incident in place to add `info.videoSource` if missing."""
    info = incident.get("info") or {}
    if info.get("videoSource"):
        return

    stream_id = (
        info.get("streamId")
        or safe_get(incident, "llm", "queries", 0, "params", "streamId")
        or incident.get("sensorId")
    )
    if not stream_id:
        return

    resolved_url = await _resolve_video_url(
        stream_id=stream_id,
        start_time=incident.get("timestamp", ""),
        end_time=incident.get("end", incident.get("timestamp", "")),
    )
    if resolved_url:
        if not isinstance(incident.get("info"), dict):
            incident["info"] = {}
        incident["info"]["videoSource"] = resolved_url


# ---------------------------------------------------------------------------
# Fan-out
# ---------------------------------------------------------------------------

async def _fan_out(coroutines: list) -> list[NotifierResult]:
    """Run backend coroutines concurrently and normalise exceptions to results."""
    raw_results = await asyncio.gather(*coroutines, return_exceptions=True)
    results: list[NotifierResult] = []
    for backend, outcome in zip(_backends, raw_results):
        if isinstance(outcome, NotifierResult):
            results.append(outcome)
        else:
            logger.exception(
                "Backend '%s' raised unexpectedly: %s",
                backend.name, outcome,
            )
            results.append(NotifierResult(
                backend=backend.name,
                success=False,
                error=f"Unhandled exception: {outcome}",
            ))
    return results


def _results_to_response(results: list[NotifierResult]) -> dict:
    return {
        "status": "ok" if all(r.success for r in results) else "partial",
        "per_backend": {
            r.backend: {
                "success": r.success,
                "error": r.error,
                **r.detail,
            }
            for r in results
        },
    }


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    global VST_ENDPOINT, VST_PUBLIC_URL_BASE, _http_client, _start_time, _backends

    logger.info("=" * 60)
    logger.info("Alert Notify - starting up")
    logger.info("=" * 60)

    backend_names = _parse_backend_names()
    logger.info("NOTIFY_BACKENDS = %s", backend_names)

    VST_ENDPOINT = os.environ.get("VST_ENDPOINT", "").strip() or None
    if not VST_ENDPOINT:
        logger.error("VST_ENDPOINT is not set")
        sys.exit(1)
    logger.info("VST_ENDPOINT = %s", VST_ENDPOINT)

    VST_PUBLIC_URL_BASE = os.environ.get("VST_PUBLIC_URL_BASE", "").strip() or None
    if VST_PUBLIC_URL_BASE:
        logger.info("VST_PUBLIC_URL_BASE = %s (videoUrls will be rewritten)", VST_PUBLIC_URL_BASE)
    else:
        logger.info("VST_PUBLIC_URL_BASE not set — videoUrls passed through verbatim")

    _http_client = httpx.AsyncClient(timeout=10)

    _backends = []
    for name in backend_names:
        try:
            backend = _build_backend(name)
            await backend.init()
            _backends.append(backend)
            logger.info("Backend '%s' initialized", name)
        except Exception as exc:
            logger.error("Failed to initialize backend '%s': %s", name, exc)
            sys.exit(1)

    _start_time = time.time()
    logger.info("Webhook server ready with backends: %s", [b.name for b in _backends])

    yield

    for backend in _backends:
        try:
            await backend.close()
        except Exception:
            logger.exception("Error closing backend '%s'", backend.name)
    if _http_client:
        await _http_client.aclose()
    logger.info("Shutting down")


app = FastAPI(
    title="Alert Notify",
    description="Receives VSS incident webhooks and fans them out to configured notification backends",
    version="2.0.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/webhook/alert-notify/health")
async def health():
    """Health check - returns OK if the server is running and at least one backend is ready."""
    uptime = time.time() - _start_time if _start_time else 0
    backends_ready = all(
        info.get("connected", False) for info in (b.status_info() for b in _backends)
    )
    return {
        "status": "healthy" if backends_ready and _backends else "degraded",
        "uptime_seconds": round(uptime, 1),
        "backends": [b.name for b in _backends],
        "vst_endpoint": VST_ENDPOINT,
        "vst_public_url_base": VST_PUBLIC_URL_BASE,
        "notifications_sent": _notification_count,
    }


@app.get("/webhook/alert-notify/status")
async def status():
    """Detailed status with per-backend breakdown."""
    uptime = time.time() - _start_time if _start_time else 0
    return {
        "service": "alert-notify",
        "status": "running",
        "uptime_seconds": round(uptime, 1),
        "started_at": (
            datetime.fromtimestamp(_start_time, tz=timezone.utc).isoformat()
            if _start_time else None
        ),
        "backends": [b.name for b in _backends],
        "vst": {"endpoint": VST_ENDPOINT, "public_url_base": VST_PUBLIC_URL_BASE},
        "stats": {"notifications_sent": _notification_count},
        "per_backend": {b.name: b.status_info() for b in _backends},
    }


@app.post("/webhook/alert-notify")
async def receive_incident(request: Request):
    """Receive an incident payload and fan it out to all configured backends."""
    global _notification_count

    if not _backends:
        raise HTTPException(status_code=503, detail="No backends configured")

    try:
        incident: dict = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    logger.info(
        "Received incident: id=%s, category=%s, verdict=%s",
        incident.get("Id", "?"),
        incident.get("category", "?"),
        incident.get("info", {}).get("verdict", "?"),
    )

    await _enrich_incident_with_video(incident)

    results = await _fan_out([b.send(incident) for b in _backends])
    if any(r.success for r in results):
        _notification_count += 1

    response = _results_to_response(results)
    if not any(r.success for r in results):
        raise HTTPException(status_code=502, detail=response)
    return response


@app.post("/webhook/alert-notify-slack")
async def receive_incident_legacy(request: Request):
    """Backwards-compatible alias for the pre-rename Slack-only endpoint.

    Older Alert Bridge deployments still POST to ``/webhook/alert-notify-slack``.
    This alias forwards the request to the canonical handler.  Remove once
    every Alert Bridge config has been migrated to ``/webhook/alert-notify``.
    """
    return await receive_incident(request)


@app.post("/webhook/alert-notify/test")
async def send_test():
    """Send a test notification through every configured backend."""
    global _notification_count

    if not _backends:
        raise HTTPException(status_code=503, detail="No backends configured")

    results = await _fan_out([b.send_test() for b in _backends])
    if any(r.success for r in results):
        _notification_count += 1

    response = _results_to_response(results)
    response["message"] = "Test notification dispatched"
    if not any(r.success for r in results):
        raise HTTPException(status_code=502, detail=response)
    return response


@app.post("/webhook/alert-notify/stop")
async def stop_server():
    """Gracefully stop the webhook server."""
    logger.info("Stop requested via API - shutting down")

    async def _shutdown():
        await asyncio.sleep(0.5)
        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.create_task(_shutdown())

    return {
        "status": "stopping",
        "message": "Server is shutting down",
        "notifications_sent": _notification_count,
    }


def main():
    import uvicorn

    host = os.environ.get("WEBHOOK_HOST", "0.0.0.0")
    port = int(os.environ.get("WEBHOOK_PORT", "9090"))

    logger.info("Starting on %s:%d", host, port)
    uvicorn.run(
        "server:app",
        host=host,
        port=port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
