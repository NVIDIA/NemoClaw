# Routing: Python API Examples

## VRP with Time Windows & Capacities

```python
"""
Vehicle Routing Problem with:
- 1 depot (location 0)
- 5 customer locations (1-5)
- 2 vehicles with capacity 100 each
- Time windows for each location
- Demand at each customer
"""
import cudf
from cuopt import routing

# Cost/distance matrix (6x6: depot + 5 customers)
cost_matrix = cudf.DataFrame([
    [0,  10, 15, 20, 25, 30],  # From depot
    [10,  0, 12, 18, 22, 28],  # From customer 1
    [15, 12,  0, 10, 15, 20],  # From customer 2
    [20, 18, 10,  0,  8, 15],  # From customer 3
    [25, 22, 15,  8,  0, 10],  # From customer 4
    [30, 28, 20, 15, 10,  0],  # From customer 5
], dtype="float32")

# Also use as transit time matrix (same values for simplicity)
transit_time_matrix = cost_matrix.copy(deep=True)

# Order data (customers 1-5)
order_locations = cudf.Series([1, 2, 3, 4, 5], dtype="int32")  # Location indices for orders

# Demand at each customer (single capacity dimension)
demand = cudf.Series([20, 30, 25, 15, 35], dtype="int32")

# Vehicle capacities (must match demand dimensions)
vehicle_capacity = cudf.Series([100, 100], dtype="int32")

# Time windows for orders [earliest, latest]
order_earliest = cudf.Series([0,  10, 20,  0, 30], dtype="int32")
order_latest = cudf.Series([50, 60, 70, 80, 90], dtype="int32")

# Service time at each customer
service_times = cudf.Series([5, 5, 5, 5, 5], dtype="int32")

# Fleet configuration
n_fleet = 2

# Vehicle start/end locations (both start and return to depot)
vehicle_start = cudf.Series([0, 0], dtype="int32")
vehicle_end = cudf.Series([0, 0], dtype="int32")

# Vehicle time windows (operating hours)
vehicle_earliest = cudf.Series([0, 0], dtype="int32")
vehicle_latest = cudf.Series([200, 200], dtype="int32")

# Build the data model
dm = routing.DataModel(
    n_locations=cost_matrix.shape[0],
    n_fleet=n_fleet,
    n_orders=len(order_locations)
)

# Add matrices
dm.add_cost_matrix(cost_matrix)
dm.add_transit_time_matrix(transit_time_matrix)

# Add order data
dm.set_order_locations(order_locations)
dm.set_order_time_windows(order_earliest, order_latest)
dm.set_order_service_times(service_times)

# Add capacity dimension (name, demand_per_order, capacity_per_vehicle)
dm.add_capacity_dimension("weight", demand, vehicle_capacity)

# Add fleet data
dm.set_vehicle_locations(vehicle_start, vehicle_end)
dm.set_vehicle_time_windows(vehicle_earliest, vehicle_latest)

# Configure solver
ss = routing.SolverSettings()
ss.set_time_limit(10)  # seconds

# Solve
solution = routing.Solve(dm, ss)

# Check solution status
print(f"Status: {solution.get_status()}")

# Display routes
if solution.get_status() == 0:  # Success
    print("\n--- Solution Found ---")
    solution.display_routes()

    # Get detailed route data
    route_df = solution.get_route()
    print("\nDetailed route data:")
    print(route_df)

    # Get objective value (total cost)
    print(f"\nTotal cost: {solution.get_total_objective()}")
else:
    print("No feasible solution found (status != 0).")
```

## Pickup and Delivery Problem (PDP)

```python
"""
Pickup and Delivery Problem:
- Items must be picked up from one location and delivered to another
- Same vehicle must do both pickup and delivery
- Pickup must occur before delivery
"""
import cudf
from cuopt import routing

# Cost matrix (depot + 4 locations)
cost_matrix = cudf.DataFrame([
    [0, 10, 20, 30, 40],
    [10, 0, 15, 25, 35],
    [20, 15, 0, 10, 20],
    [30, 25, 10, 0, 15],
    [40, 35, 20, 15, 0],
], dtype="float32")

transit_time_matrix = cost_matrix.copy(deep=True)

n_fleet = 2
n_orders = 4  # 2 pickup-delivery pairs = 4 orders

# Orders: pickup at loc 1 -> deliver at loc 2, pickup at loc 3 -> deliver at loc 4
order_locations = cudf.Series([1, 2, 3, 4], dtype="int32")

# Pickup and delivery pairs (indices into order array)
# Order 0 (pickup) pairs with Order 1 (delivery)
# Order 2 (pickup) pairs with Order 3 (delivery)
pickup_indices = cudf.Series([0, 2])
delivery_indices = cudf.Series([1, 3])

# Demand: positive for pickup, negative for delivery (must sum to 0 per pair)
demand = cudf.Series([10, -10, 15, -15], dtype="int32")
vehicle_capacity = cudf.Series([50, 50], dtype="int32")

# Build model
dm = routing.DataModel(
    n_locations=cost_matrix.shape[0],
    n_fleet=n_fleet,
    n_orders=n_orders
)

dm.add_cost_matrix(cost_matrix)
dm.add_transit_time_matrix(transit_time_matrix)
dm.set_order_locations(order_locations)

# Add capacity dimension
dm.add_capacity_dimension("load", demand, vehicle_capacity)

# Set pickup and delivery constraints
dm.set_pickup_delivery_pairs(pickup_indices, delivery_indices)

# Fleet setup
dm.set_vehicle_locations(
    cudf.Series([0, 0]),  # Start at depot
    cudf.Series([0, 0])   # Return to depot
)

# Solve
ss = routing.SolverSettings()
ss.set_time_limit(10)
solution = routing.Solve(dm, ss)

print(f"Status: {solution.get_status()}")
if solution.get_status() == 0:
    solution.display_routes()
```

## Minimal VRP (Quick Start)

```python
import cudf
from cuopt import routing

# Minimal 4-location problem
cost_matrix = cudf.DataFrame([
    [0, 10, 15, 20],
    [10, 0, 12, 18],
    [15, 12, 0, 10],
    [20, 18, 10, 0],
], dtype="float32")

dm = routing.DataModel(n_locations=4, n_fleet=1, n_orders=3)
dm.add_cost_matrix(cost_matrix)
dm.set_order_locations(cudf.Series([1, 2, 3], dtype="int32"))

solution = routing.Solve(dm, routing.SolverSettings())

if solution.get_status() == 0:
    solution.display_routes()
```

## Multi-Depot VRP

```python
import cudf
from cuopt import routing

# 6 locations: 2 depots (0, 1) + 4 customers (2, 3, 4, 5)
cost_matrix = cudf.DataFrame([
    [0, 5, 10, 15, 20, 25],
    [5, 0, 12, 8, 18, 22],
    [10, 12, 0, 6, 14, 16],
    [15, 8, 6, 0, 10, 12],
    [20, 18, 14, 10, 0, 8],
    [25, 22, 16, 12, 8, 0],
], dtype="float32")

n_fleet = 2

dm = routing.DataModel(n_locations=6, n_fleet=n_fleet, n_orders=4)
dm.add_cost_matrix(cost_matrix)
dm.set_order_locations(cudf.Series([2, 3, 4, 5], dtype="int32"))

# Vehicle 0 starts/ends at depot 0, Vehicle 1 at depot 1
dm.set_vehicle_locations(
    cudf.Series([0, 1]),  # start locations
    cudf.Series([0, 1])   # end locations
)

solution = routing.Solve(dm, routing.SolverSettings())
if solution.get_status() == 0:
    solution.display_routes()
```

---

## Additional References (tested in CI)

For more complete examples, read these files:

| Example | File | Description |
|---------|------|-------------|
| Basic Routing | `docs/cuopt/source/cuopt-server/examples/routing/examples/basic_routing_example.py` | Server-based routing |
| Initial Solution | `docs/cuopt/source/cuopt-server/examples/routing/examples/initial_solution_example.py` | Warm starting |
| Smoke Test | `docs/cuopt/source/cuopt-python/routing/examples/smoke_test_example.sh` | Quick validation |

These examples are tested by CI and represent canonical usage.

**Note:** The Python routing API documentation is in `python/cuopt/cuopt/routing/vehicle_routing.py` (docstrings).
