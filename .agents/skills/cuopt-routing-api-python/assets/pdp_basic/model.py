# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""
PDP: 2 pickup-delivery pairs, 2 vehicles. Pickup before delivery; capacity dimension.
"""

import cudf
from cuopt import routing

cost_matrix = cudf.DataFrame(
    [
        [0, 10, 20, 30, 40],
        [10, 0, 15, 25, 35],
        [20, 15, 0, 10, 20],
        [30, 25, 10, 0, 15],
        [40, 35, 20, 15, 0],
    ],
    dtype="float32",
)

transit_time_matrix = cost_matrix.copy(deep=True)
n_fleet = 2
n_orders = 4

order_locations = cudf.Series([1, 2, 3, 4], dtype="int32")
pickup_indices = cudf.Series([0, 2])
delivery_indices = cudf.Series([1, 3])
demand = cudf.Series([10, -10, 15, -15], dtype="int32")
vehicle_capacity = cudf.Series([50, 50], dtype="int32")

dm = routing.DataModel(
    n_locations=cost_matrix.shape[0],
    n_fleet=n_fleet,
    n_orders=n_orders,
)
dm.add_cost_matrix(cost_matrix)
dm.add_transit_time_matrix(transit_time_matrix)
dm.set_order_locations(order_locations)
dm.add_capacity_dimension("load", demand, vehicle_capacity)
dm.set_pickup_delivery_pairs(pickup_indices, delivery_indices)
dm.set_vehicle_locations(
    cudf.Series([0, 0], dtype="int32"),
    cudf.Series([0, 0], dtype="int32"),
)

ss = routing.SolverSettings()
ss.set_time_limit(10)
solution = routing.Solve(dm, ss)

print(f"Status: {solution.get_status()}")
if solution.get_status() == 0:
    solution.display_routes()
    print(f"Total cost: {solution.get_total_objective()}")
else:
    print(solution.get_error_message())
