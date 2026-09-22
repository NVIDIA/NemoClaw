# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Read the existing Pi host status without configuring or invoking an agent."""
import asyncio
import json
import sys


async def observe(path):
    reader, writer = await asyncio.open_unix_connection(path, limit=1 << 20)
    try:
        writer.write(b'{"operation":"check"}\n')
        await writer.drain()
        return json.loads(await asyncio.wait_for(reader.readline(), 10))
    finally:
        writer.close()
        await writer.wait_closed()


if __name__ == "__main__":
    sys.path.insert(0, "/opt/nemoclaw")
    from fabric import SOCKET

    print(json.dumps(asyncio.run(observe(SOCKET))))
