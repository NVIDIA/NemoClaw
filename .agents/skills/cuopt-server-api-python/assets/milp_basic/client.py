# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""
REST client: MILP (same constraints as LP but variable_types: integer, continuous).
Requires cuOpt server running. Exits 0 if server unreachable.
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
        "csr_constraint_matrix": {
            "offsets": [0, 2, 4],
            "indices": [0, 1, 0, 1],
            "values": [2.0, 3.0, 4.0, 2.0],
        },
        "constraint_bounds": {
            "upper_bounds": [240.0, 200.0],
            "lower_bounds": ["ninf", "ninf"],
        },
        "objective_data": {"coefficients": [40.0, 30.0]},
        "variable_bounds": {
            "upper_bounds": ["inf", "inf"],
            "lower_bounds": [0.0, 0.0],
        },
        "variable_types": ["integer", "continuous"],
        "maximize": True,
        "solver_config": {
            "time_limit": 120,
            "tolerances": {"mip_relative_gap": 0.01},
        },
    }

    response = requests.post(
        f"{SERVER}/cuopt/request", json=payload, headers=HEADERS
    )
    response.raise_for_status()
    req_id = response.json()["reqId"]
    print(f"Submitted: {req_id}")

    for _ in range(60):
        response = requests.get(
            f"{SERVER}/cuopt/solution/{req_id}", headers=HEADERS
        )
        result = response.json()

        if "response" in result:
            print(f"Status: {result['response'].get('status')}")
            print(f"Objective: {result['response'].get('objective_value')}")
            print(f"Solution: {result['response'].get('primal_solution')}")
            return
        time.sleep(1)

    print("Timeout waiting for solution")
    sys.exit(1)


if __name__ == "__main__":
    main()
