# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Minimal VRP: 4 locations, 1 vehicle, 3 orders. Cost matrix only.
"""

import cudf
from cuopt import routing

cost_matrix = cudf.DataFrame(
    [
        [0, 10, 15, 20],
        [10, 0, 12, 18],
        [15, 12, 0, 10],
        [20, 18, 10, 0],
    ],
    dtype="float32",
)

dm = routing.DataModel(n_locations=4, n_fleet=1, n_orders=3)
dm.add_cost_matrix(cost_matrix)
dm.set_order_locations(cudf.Series([1, 2, 3], dtype="int32"))

solution = routing.Solve(dm, routing.SolverSettings())

if solution.get_status() == 0:
    solution.display_routes()
    print(f"Total cost: {solution.get_total_objective()}")
else:
    print(f"Status: {solution.get_status()}", solution.get_error_message())
