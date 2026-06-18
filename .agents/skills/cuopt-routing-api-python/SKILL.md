---
name: cuopt-routing-api-python
version: "26.08.00"
description: Vehicle routing (VRP, TSP, PDP) with cuOpt — Python API only. Use when the user is building or solving routing in Python.
license: Apache-2.0
metadata:
  author: NVIDIA cuOpt Team
  tags:
    - cuopt
    - routing
    - vrp
    - tsp
    - python
---



# cuOpt Routing — Python API

Confirm problem type (TSP, VRP, PDP) and data (locations, orders, fleet, constraints) before coding.

This skill is **Python only**. Routing has no C API in cuOpt.

## Minimal VRP Example

```python
import cudf
from cuopt import routing

cost_matrix = cudf.DataFrame([...], dtype="float32")
dm = routing.DataModel(n_locations=4, n_fleet=2, n_orders=3)
dm.add_cost_matrix(cost_matrix)
dm.set_order_locations(cudf.Series([1, 2, 3], dtype="int32"))
solution = routing.Solve(dm, routing.SolverSettings())

if solution.get_status() == 0:
    solution.display_routes()
```

## Adding Constraints

```python
# Time windows
dm.add_transit_time_matrix(transit_time_matrix)
dm.set_order_time_windows(earliest_series, latest_series)

# Capacities
dm.add_capacity_dimension("weight", demand_series, capacity_series)
dm.set_order_service_times(service_times)
dm.set_vehicle_locations(start_locations, end_locations)
dm.set_vehicle_time_windows(earliest_start, latest_return)

# Pickup-delivery pairs
dm.set_pickup_delivery_pairs(pickup_indices, delivery_indices)

# Precedence
dm.add_order_precedence(node_id=2, preceding_nodes=np.array([0, 1]))
```

## Solution Checking

```python
status = solution.get_status()  # 0=SUCCESS, 1=FAIL, 2=TIMEOUT, 3=EMPTY
if status == 0:
    route_df = solution.get_route()
    total_cost = solution.get_total_objective()
else:
    print(solution.get_error_message())
    print(solution.get_infeasible_orders().to_list())
```

## Data Types (use explicit dtypes)

```python
cost_matrix = cost_matrix.astype("float32")
order_locations = cudf.Series([...], dtype="int32")
demand = cudf.Series([...], dtype="int32")
```

## Solver Settings

```python
ss = routing.SolverSettings()
ss.set_time_limit(30)
ss.set_verbose_mode(True)
ss.set_error_logging_mode(True)
```

## Common Issues

| Problem | Fix |
|---------|-----|
| Empty solution | Widen time windows or check travel times |
| Infeasible orders | Increase fleet or capacity |
| Status != 0 with time windows | Add `add_transit_time_matrix()` |
| Wrong cost | Check cost_matrix is symmetric |
| `compute_waypoint_sequence` alters route_df | It replaces the `location` column with waypoint ids in place — pass `route_df.copy()` if you still need cost-matrix indices (e.g. when iterating per truck) |

## Debugging

**When status != 0:** `print(solution.get_error_message())` and `print(solution.get_infeasible_orders().to_list())` to see which orders are infeasible.

**Data types:** Use explicit dtypes (float32, int32) for matrices and series to avoid silent errors.

## Examples

- [examples.md](references/examples.md) — VRP, PDP, multi-depot
- [server_examples.md](references/server_examples.md) — REST client (curl, Python)
- **Reference models:** This skill's `assets/` — [vrp_basic](assets/vrp_basic/), [pdp_basic](assets/pdp_basic/). See [assets/README.md](assets/README.md).

## Escalate

For contribution or build-from-source, see the developer skill.
