#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""TCP barrier for synchronizing parallel OSMO tasks (rank 0 = server, others = clients)."""

from __future__ import annotations

import argparse
import asyncio
import socket


class SyncServer:
    def __init__(self, port: int, num_nodes: int):
        self._port = port
        self._num_nodes = num_nodes
        self._server = None
        self._connected_ranks = set()
        self._connections = set()
        self._ready_to_send = asyncio.Event()
        self._failed = False
        self._failure_reason = False
        self._status_interval = 10

    async def status_print(self):
        all_ranks = {i for i in range(1, self._num_nodes)}
        while True:
            outstanding_workers = all_ranks - self._connected_ranks
            print(
                f"{len(self._connected_ranks)}/{len(all_ranks)} workers connected, "
                f'waiting on ranks: {", ".join(str(x) for x in outstanding_workers)}'
            )
            await asyncio.sleep(self._status_interval)

    async def run(self):
        self._server = await asyncio.start_server(self.handle_connection, host="0.0.0.0", port=self._port)
        async with self._server:
            loop = asyncio.get_event_loop()
            server_task = loop.create_task(self._server.serve_forever())
            loop.create_task(self.status_print())

            if self._num_nodes == 1:
                self._ready_to_send.set()

            await self._ready_to_send.wait()
            for connection in self._connections:
                if self._failed:
                    connection.write(f"FAILED: {self._failure_reason}".encode("utf-8"))
                else:
                    connection.write(b"OK")
                connection.close()
            server_task.cancel()

        return not self._failed

    def fail(self, message):
        self._failed = True
        self._failure_reason = message
        self._ready_to_send.set()
        print(f"Failing due to: {message}")

    def add_rank(self, rank):
        print(f"New connection from {rank}")
        if rank in self._connected_ranks:
            self.fail(f"More than one node with rank {rank} connected!")
            return

        if rank < 1 or rank >= self._num_nodes:
            self.fail(f"Got connection from {rank} which is outside of the range [1, {self._num_nodes - 1}]")

        self._connected_ranks.add(rank)
        if len(self._connected_ranks) == self._num_nodes - 1:
            self._ready_to_send.set()

    def remove_rank(self, rank):
        if rank is not None:
            self._connected_ranks.remove(rank)

    async def handle_connection(self, reader, writer):
        try:
            rank = None
            self._connections.add(writer)

            line = await reader.readline()
            try:
                rank = int(line.decode("utf-8"))
            except ValueError as error:
                self.fail(f"Encountered exception {error}")
                return

            self.add_rank(rank)

            await reader.read(1)
            self._connections.remove(writer)

        finally:
            if rank:
                self.remove_rank(rank)
            writer.close()
            await writer.wait_closed()
            print(f"Disconnecting {rank}")


async def run_client(host, port, rank):
    while True:
        try:
            reader, writer = await asyncio.open_connection(host, port)
            break
        except (ConnectionRefusedError, socket.gaierror) as error:
            print(f'Connection to rank 0 failed due to "{error}", trying again in 10s...')
            await asyncio.sleep(10)
    print("Successfully connected to rank 0")
    writer.write(f"{rank}\n".encode("utf-8"))
    status = (await reader.read()).decode("utf-8")
    print(status)
    return status.startswith("OK")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Allows multiple osmo tasks to synchronize")
    parser.add_argument(
        "--connect",
        help="Provide if this is not rank 0. The ip or hostname to connect to",
    )
    parser.add_argument("--port", type=int, default=12344, help="Port to use on rank 0")
    parser.add_argument(
        "--rank",
        type=int,
        required=True,
        help="A number from 0 to (n-1) where n is the number of nodes",
    )
    parser.add_argument("--num_nodes", type=int, required=True, help="The number of nodes")

    args = parser.parse_args(argv)

    if args.rank >= args.num_nodes:
        print(f"Rank ({args.rank}) must be less than num nodes ({args.num_nodes})")
        return 1

    if args.rank < 0:
        print(f"Rank ({args.rank}) must be greater than or equal to 0")
        return 1

    if not args.connect and args.rank != 0:
        print('Must provide "--connect <ip/hostname of rank 0>" flag rank != 0')
        return 1

    loop = asyncio.get_event_loop()
    if args.rank == 0:
        server = SyncServer(args.port, args.num_nodes)
        success = loop.run_until_complete(server.run())
    else:
        success = loop.run_until_complete(run_client(args.connect, args.port, args.rank))
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
