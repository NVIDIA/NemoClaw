# cuOpt VRP Dimension Developer Skills

---

## `cuopt-dimension-architecture`

**When to use**: Before implementing any new constraint or objective in cuOpt.

### The forward/backward propagation model
Each node stores accumulated state (`fwd_X`, `bwd_X`) so that combining any two adjacent fragments is O(1). This is the core design contract that makes cuOpt fast:
- `fwd_X[k]` = contribution of the prefix `[0..k]`
- `bwd_X[k]` = contribution of the suffix `[k..n]`
- No recomputation is needed when a move splits a route at any point

### The combine invariant
`combine(node[k], node[k+1])` must return the **same value for every split point `k`** in a route (within floating-point tolerance — small differences from order of operations are acceptable; large gaps indicate a bug). This is the fundamental correctness contract. Violating it breaks local search delta evaluation (the solver computes `cost_after - cost_before` using combine; if combine is materially inconsistent, deltas are wrong).

### Why boundaries double-count
`fwd_excess[k]` accumulates violations from `[0..k]`. `bwd_excess[k+1]` accumulates violations from `[k+1..n]`. At the join point `k → k+1`, both sides have already "seen" the in-transit state at that boundary — so their sum overcounts the boundary contribution once. The correction term `excess(fwd_state[k])` subtracts the double-counted boundary:
```
combine(k, k+1) = fwd_excess[k] + bwd_excess[k+1] - excess(fwd_state[k])
```

### Required interface for every dimension
| Method | Description |
|--------|-------------|
| `calculate_forward(next)` | Propagate fwd state from `this` to `next`; update `next.fwd_excess` |
| `calculate_backward(prev)` | Propagate bwd state from `this` to `prev`; update `prev.bwd_excess` |
| `combine(prev, next)` | O(1) total cost for joining two fragments; must satisfy the invariant |
| `get_cost(prev, this)` | Same formula as `combine`, called from `next`'s perspective |
| `compute_cost(n_nodes)` | Full-route cost; must equal `combine(last_node, return_depot)` |
| `forward_excess` | Returns `fwd_excess` as double |
| `backward_excess` | Returns `bwd_excess` as double |
| `forward_feasible` | True if `fwd_excess <= excess_limit` |
| `backward_feasible` | True if `bwd_excess <= excess_limit` |

---

## `cuopt-implement-dimension`

**When to use**: When given a constraint/objective description to implement as a new cuOpt dimension.

### Step-by-step recipe

**Step 1 — Define per-node state**
Identify the minimal set of scalars needed for O(1) propagation:
- What is "in transit" at each route position? (e.g. load, type counts, time)
- What accumulated violation measure can be updated incrementally? (e.g. excess load, incompatibility excess)
- Separate: *fixed data* (set once from problem input), *forward data*, *backward data*

**Step 2 — Write `calculate_forward(next)`**
```
propagate accumulated fwd_state from this → next
apply next node's demand to fwd_state
compute positional_excess = f(fwd_state_at_next)
next.fwd_excess = this.fwd_excess + positional_excess   // depot nodes: no positional contribution
```

**Step 3 — Write `calculate_backward(prev)`**
Mirror of forward, applied in reverse direction. Backward demand direction is opposite to forward (e.g. a pickup that adds +1 forward subtracts -1 backward).

**Step 4 — Derive `combine(prev, next)`**

`combine` is the **core cost computation for every local search move**: operators evaluate candidate edits by differencing combined fragment costs (`cost_after - cost_before`). It is called extremely often, so **keep it as fast as possible**.

- **Typical dimensions** (capacity, distance, simple time windows, etc.): `combine` is **O(1)** — only prefix/suffix scalars and a boundary correction. This is what all current VRP operators assume.
- **Richer dimensions** can be **much more expensive** — e.g. **O(log n)** in route size `n` when the join cost needs a non-trivial lookup (time-dependent travel times, multiple time windows, profile queries). Prefer precomputed tables or cached state so `combine` stays hot-path friendly; if it must be superlinear, document it and expect fewer applicable operators or higher move-evaluation cost.

Write out the invariant formula and verify it equals the total route cost for a complete route:
```
total = prev.fwd_excess + next.bwd_excess - boundary_correction(prev.fwd_state)
```
where `boundary_correction` removes the double-counted overlap at the join point.

**Step 5 — Derive `get_cost(prev, this)` from combine**

`get_cost` is on the **same hot path as `combine`**: local search operators call it constantly when scoring edges and fragments. It must stay **as fast as `combine`** — same **O(1)** target for typical dimensions, same risk of **O(log n)** or worse for time-dependent travel, multiple time windows, etc. **Do not** put a separate heavy computation here.

`get_cost` is called on the `next` node with `prev` passed in. It must be identical to `combine` — substitute `this` for `next`:
```
get_cost(prev, this) == combine(prev, this)
```
Implement by **delegating to `combine`** (or inlining the same formula). Do **not** derive an independent formula; any deviation breaks coherence assertions and can hide a slower code path.

**Step 6 — Write `compute_cost(n_nodes)`**
Must equal `combine(last_service_node, fresh_return_depot)` within the same floating-point tolerance:
```
compute_cost = fwd_excess[n_nodes] - boundary_correction(fwd_state[n_nodes])
```
(For a balanced route, `bwd_excess` at the return depot is 0 and `bwd_state` is 0, so the depot term drops out.)

**Step 7 — Create the node class**
File: `cpp/src/routing/node/your_node.cuh`
- Fixed data fields (problem input)
- `fwd_state[]`, `fwd_excess`, `bwd_state[]`, `bwd_excess`
- All 9 interface methods listed in `cuopt-dimension-architecture`

**Step 8 — Create the route class**
File: `cpp/src/routing/route/your_route.cuh`
- Host-side: `rmm::device_uvector` for each array (fixed, fwd, bwd)
- Device-side `view_t`: `raft::device_span` members, `get_node`, `set_node`, `set_forward_data`, `set_backward_data`, `copy_forward_data`, `copy_backward_data`, `copy_fixed_route_data`, `compute_cost`, `create_shared_route`, `get_shared_size`
- Stride layout: all arrays use `stride = n_nodes_route + 1`; multi-type arrays are row-major `[n_types * stride]`

---

## `cuopt-dimension-wiring-checklist`

**When to use**: After writing node/route logic, to ensure the dimension is fully integrated into the framework.

### Files to create
- [ ] `cpp/src/routing/node/your_node.cuh`
- [ ] `cpp/src/routing/route/your_route.cuh`

### Files to modify

**`cpp/src/routing/routing_helpers.cuh`** (or `dimensions_info`)
- [ ] Add new `dim_t` enum value
- [ ] `enabled_dimensions_t::has_dimension` covers it
- [ ] `enabled_dimensions_t::get_dimension<dim>` covers it
- [ ] `loop_over_dimensions` range covers it (check `Start`/`End` bounds)

**`cpp/src/routing/route/dimensions_route.cuh`**
- [ ] Add to `route_from_dim<I>` type alias chain
- [ ] Add member `your_route_t<i_t, f_t> your_dim` to `dimensions_route_t`
- [ ] Initialize in constructor: `your_dim(sol_handle_, dimensions_info_.get_dimension<dim_t::YOUR_DIM>())`
- [ ] Copy constructor copies `your_dim`
- [ ] `view_t` has `typename your_route_t<i_t, f_t>::view_t your_dim` member
- [ ] `view()` calls `get_dimension_of<I>(v) = get_dimension_of<I>(*this).view()` via loop — automatic if wired into enum

**`cpp/src/routing/node/node.cuh`**
- [ ] `get_dimension<dim_t::YOUR_DIM>()` returns `your_dim` member — add to the accessor chain

**`cpp/src/routing/problem/problem.cuh`**
- [ ] Add storage for input data (e.g. `std::vector<int> order_incompatible_types`)
- [ ] Add setter method

**`cpp/src/routing/problem/problem.cu`**
- [ ] `populate_dimensions_info()`: enable dimension when input data is non-empty

**`cpp/src/routing/util_kernels/set_nodes_data.cuh`**
- [ ] Depot boundary initialization in `set_route_data`: set `fwd_state[0] = 0`, `fwd_excess[0] = 0`, `bwd_state[n_nodes] = 0`, `bwd_excess[n_nodes] = 0`

**`cpp/src/routing/fleet_info.hpp`** (if dimension has vehicle-level parameters)
- [ ] Add vehicle-level constraint data

**Python/C API**
- [ ] Expose setter in C API header
- [ ] Python binding in the routing data class

---

## `cuopt-dimension-testing`

**When to use**: After implementing a new dimension, to write tests that validate correctness end-to-end.

### C++ unit tests (`cpp/tests/routing/`)
- Add a simple unit test with less than 10 nodes/orders

### Python integration tests (`python/cuopt/cuopt/tests/routing/`)
- Add a similar test in python to test the Python APIs and end-to-end testing

### What every test should verify
- `is_feasible()` for the final solution when feasibility is expected
- Infeasibility cost for the new dimension is 0 in a feasible solution
- Optimal objective value is obtained for curated tests
- Edge cases: empty route, single-node route, all nodes same type/value
