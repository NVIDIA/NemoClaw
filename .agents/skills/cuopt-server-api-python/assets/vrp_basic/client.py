# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""
REST client: VRP with time windows. Requires cuOpt server running.

Usage: python client.py
  Set CUOPT_SERVER_URL (default http://localhost:8000). Exits 0 if server unreachable (e.g. in CI without server).
"""

import os
import sys
import time

import requests

SERVER = os.environ.get("CUOPT_SERVER_URL", "http://localhost:8000")
HEADERS = {"Content-Type": "application/json", "CLIENT-VERSION": "custom"}


def server_ok():
    try:
        r = requests.get(f"{SERVER}/cuopt/health", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def main():
    if not server_ok():
        print(
            "Server not running, skipping. Start with: python -m cuopt_server.cuopt_service --ip 0.0.0.0 --port 8000"
        )
        sys.exit(0)

    payload = {
        "cost_matrix_data": {
            "data": {
                "0": [
                    [0, 10, 15, 20, 25],
                    [10, 0, 12, 18, 22],
                    [15, 12, 0, 10, 15],
                    [20, 18, 10, 0, 8],
                    [25, 22, 15, 8, 0],
                ]
            }
        },
        "travel_time_matrix_data": {
            "data": {
                "0": [
                    [0, 10, 15, 20, 25],
                    [10, 0, 12, 18, 22],
                    [15, 12, 0, 10, 15],
                    [20, 18, 10, 0, 8],
                    [25, 22, 15, 8, 0],
                ]
            }
        },
        "task_data": {
            "task_locations": [1, 2, 3, 4],
            "demand": [[20, 30, 25, 15]],
            "task_time_windows": [[0, 50], [10, 60], [20, 70], [0, 80]],
            "service_times": [5, 5, 5, 5],
        },
        "fleet_data": {
            "vehicle_locations": [[0, 0], [0, 0]],
            "capacities": [[100, 100]],
            "vehicle_time_windows": [[0, 200], [0, 200]],
        },
        "solver_config": {"time_limit": 10},
    }

    response = requests.post(
        f"{SERVER}/cuopt/request", json=payload, headers=HEADERS
    )
    response.raise_for_status()
    req_id = response.json()["reqId"]
    print(f"Submitted: {req_id}")

    for _ in range(30):
        response = requests.get(
            f"{SERVER}/cuopt/solution/{req_id}", headers=HEADERS
        )
        result = response.json()

        if "response" in result:
            solver_response = result["response"].get("solver_response", {})
            print(f"Status: {solver_response.get('status')}")
            print(f"Cost: {solver_response.get('solution_cost')}")
            if "vehicle_data" in solver_response:
                for vid, vdata in solver_response["vehicle_data"].items():
                    print(f"Vehicle {vid}: {vdata.get('route', [])}")
            return
        time.sleep(1)

    print("Timeout waiting for solution")
    sys.exit(1)


if __name__ == "__main__":
    main()
