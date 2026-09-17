# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Transport the hosted runtime's Fabric health report without invoking an agent.

Consumer contract: NeMo-Fabric PR #305 at d3aebd464458dcddeaf2965249154dbc4353c93e.
2026-09-16: bridge the proposed API; older SDKs explicitly remain unsupported.
"""

import asyncio
import json


def unavailable(reason):
    return {"supported": True, "report": None, "reason_code": reason}


async def runtime_health(runtime, timeout_seconds=3.0):
    if runtime is None:
        return unavailable("runtime_unavailable")
    check = getattr(runtime, "check_health", None)
    if check is None:
        return {"supported": False, "report": None, "reason_code": "fabric_health_unsupported"}
    try:
        result = await asyncio.wait_for(check(timeout_seconds=timeout_seconds), timeout_seconds)
        report = result.to_mapping()
        if report["runtime_id"] != runtime.runtime_id:
            raise ValueError("health runtime identity changed")
        return {"supported": True, "report": report, "reason_code": None}
    except TimeoutError:
        return unavailable("fabric_health_timeout")
    except Exception:
        return unavailable("fabric_health_error")


async def request_health(socket):
    async def request():
        reader, writer = await asyncio.open_unix_connection(socket, limit=65536)
        try:
            writer.write(b'{"operation":"health"}\n')
            await writer.drain()
            return json.loads(await reader.readline())
        finally:
            writer.close()
            await writer.wait_closed()

    try:
        return await asyncio.wait_for(request(), 5)
    except TimeoutError:
        return unavailable("health_transport_timeout")
    except Exception:
        return unavailable("health_transport_error")
