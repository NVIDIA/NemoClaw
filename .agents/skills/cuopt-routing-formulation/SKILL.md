---
name: cuopt-routing-formulation
version: "26.08.00"
description: Vehicle routing (VRP, TSP, PDP) — problem types and data requirements. Domain concepts; no API or interface.
license: Apache-2.0
metadata:
  author: NVIDIA cuOpt Team
  tags:
    - routing
    - vrp
    - tsp
    - formulation
    - concepts
---


# Routing Formulation

Domain concepts for vehicle routing. No API or interface details here.

## What is routing

- **TSP**: Single vehicle, visit all locations once (e.g. shortest tour).
- **VRP**: Multiple vehicles, capacity and/or time limits; assign orders to vehicles and sequence stops.
- **PDP**: Pickup and delivery pairs; pickup must be visited before the corresponding delivery.

## Required questions (problem and data)

Ask these if not already clear:

1. **Problem type** — TSP, VRP, or PDP?
2. **Locations** — How many? Depot(s)? Cost or distance between pairs (matrix or derived)?
3. **Orders / tasks** — Which locations must be visited? Demand or service per stop?
4. **Fleet** — Number of vehicles, capacity per vehicle (and per dimension if multiple), start/end locations?
5. **Constraints** — Time windows (earliest/latest arrival), service times, precedence (order A before B)?

## Typical data

- Cost or distance matrix (or travel-time matrix).
- Order locations and, for VRP, demand per order.
- Vehicle capacities and optional time windows for vehicles and orders.
