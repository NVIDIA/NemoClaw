---
name: cuopt-numerical-optimization-formulation
version: "26.08.00"
description: LP, MILP, QP — concepts, problem-text parsing, and formulation patterns (parameters, constraints, decisions, objective). Concepts only; no API.
license: Apache-2.0
metadata:
  author: NVIDIA cuOpt Team
  tags:
    - linear-programming
    - milp
    - qp
    - formulation
    - concepts
---


# Numerical Optimization Formulation

Concepts and workflow for going from a problem description to a clear formulation across LP, MILP, and QP. No API code here.

## What is LP / MILP / QP

- **LP**: Linear objective, linear constraints, continuous variables.
- **MILP**: Same as LP plus some integer or binary variables (e.g., scheduling, facility location, selection).
- **QP**: Quadratic objective (e.g., x², x·y terms — portfolio variance, least squares), linear constraints. **QP support in cuOpt is currently in beta.**

## Identifying problem type

| Property | LP | MILP | QP |
|---|---|---|---|
| Objective | Linear | Linear | Quadratic (xᵀQx + cᵀx) |
| Constraints | Linear | Linear | Linear (no quadratic constraints) |
| Variables | Continuous | Mixed: continuous + integer/binary | Continuous |
| Sense | min or max | min or max | **minimize only** (negate to max) |

If the objective is purely linear, prefer LP/MILP — do not artificially introduce quadratic terms. If any variable is integer or binary, the problem is MILP regardless of the rest.

## Required formulation questions

Ask these if not already clear:

1. **Decision variables** — What are they? Bounds?
2. **Objective** — Minimize or maximize? Linear or quadratic? For QP: any squared or cross terms (x², x·y)? If maximize a quadratic, the user must negate and minimize.
3. **Constraints** — Linear inequalities/equalities? (Quadratic constraints are not supported.)
4. **Variable types** — All continuous (LP / QP) or some integer/binary (MILP)?
5. **Convexity (QP only)** — For minimization, the quadratic form (matrix Q) should be positive semi-definite for well-posed problems.

## Typical modeling elements

- **Continuous variables** — production amounts, flow, allocations, portfolio weights.
- **Binary variables** — open/close, yes/no (e.g., facility open, item selected).
- **Linking constraints** — e.g., production only if facility open (Big-M or indicator).
- **Resource constraints** — linear cap on usage (materials, time, capacity).
- **Quadratic objective terms** — variance (xᵀQx), squared error (‖Ax − b‖²), interaction terms.

## Typical QP use cases

- Portfolio optimization — minimize variance subject to return and budget.
- Least squares — minimize ‖Ax − b‖² subject to linear constraints.
- Other quadratic objectives with linear constraints.

---

## Problem statement parsing

When the user gives **problem text**, classify every sentence and then summarize before formulating. The parsing framework below applies regardless of LP / MILP / QP.

**Classify every sentence** as **parameter/given**, **constraint**, **decision**, or **objective**. Watch for **implicit constraints** (e.g., committed vs optional phrasing) and **implicit objectives** (e.g., "determine the plan" + costs → minimize total cost).

**Ambiguity:** If anything is still ambiguous, ask the user or solve all plausible interpretations and report all outcomes; do not assume a single interpretation.

### 🔒 MANDATORY: When in Doubt — Ask

- If there is **any doubt** about whether a constraint or value should be included, **ask the user** and state the possible interpretations.

### 🔒 MANDATORY: Complete-Path Runs — Try All Variants

- When the user asks to **run the complete path** (e.g., end-to-end, full pipeline), run all plausible variants and **report all outcomes** so the user can choose; do not assume a single interpretation.

### Three labels

| Label | Meaning | Examples (sentence type) |
|-------|--------|---------------------------|
| **Parameter / given** | Fixed data, inputs, facts. Not chosen by the model. | "Demand is 100 units." "There are 3 factories." "Costs are $5 per unit." |
| **Constraint** | Something that must hold. May be explicit or **implicit** from phrasing. | "Capacity is 200." "All demand must be met." "At least 2 shifts must be staffed." |
| **Decision** | Something we choose or optimize. | "How much to produce." "Which facilities to open." "How many workers to hire." |
| **Objective** | What to minimize or maximize. May be **explicit** ("minimize cost") or **implicit** ("determine the plan" with costs given). | "Minimize total cost." "Determine the production plan" (with costs) → minimize total cost. |

### Implicit constraints: committed vs optional phrasing

**Committed/fixed phrasing** → treat as **parameter** or **implicit constraint** (everything mentioned is given or must happen). Not a decision.

| Phrasing | Interpretation | Why |
|----------|-----------------|-----|
| "Plans to produce X products" | **Constraint**: all X must be produced. | Commitment; production level is fixed. |
| "Operates 3 factories" | **Parameter**: all 3 are open. Not a location-selection problem. | Current state is fixed. |
| "Employs N workers" | **Parameter**: all N are employed. Not a hiring decision. | Workforce size is given. |
| "Has a capacity of C" | **Parameter** (C) + **constraint**: usage ≤ C. | Capacity is fixed. |
| "Must meet all demand" | **Constraint**: demand satisfaction. | Explicit requirement. |

**Optional/decision phrasing** → treat as **decision**.

| Phrasing | Interpretation | Why |
|----------|-----------------|-----|
| "May produce up to …" | **Decision**: how much to produce. | Optional level. |
| "Can choose to open" (factories, sites) | **Decision**: which to open. | Selection is decided. |
| "Considers hiring" | **Decision**: how many to hire. | Hiring is under consideration. |
| "Decides how much to order" | **Decision**: order quantities. | Explicit decision. |
| "Wants to minimize/maximize …" | **Objective** (drives decisions). | Goal; decisions are the levers. |

### Implicit objectives — do not miss

**If the problem asks to "determine the plan" (or similar) but does not state "minimize" or "maximize" explicitly, the objective is often implicit.** You **MUST** identify it and state it before formulating; do not build a model with no objective.

| Phrasing / context | Likely implicit objective | Why |
|-------------------|---------------------------|-----|
| "Determine the production plan" + costs given (per unit, per hour, etc.) | **Minimize total cost** (production + inspection/sales + overtime, etc.) | Plan is chosen; costs are specified → natural goal is to minimize total cost. |
| "Determine the plan" + costs and revenues given | **Maximize profit** (revenue − cost) | Both sides of the ledger → optimize profit. |
| "Try to determine the monthly production plan" + workshop hour costs, inspection/sales costs | **Minimize total cost** | All cost components are given; no revenue to maximize → minimize total cost. |

**Rule:** When the problem gives cost (or cost and revenue) data and asks to "determine", "find", or "establish" the plan, **always state the objective explicitly** (e.g., "I'm treating the objective as minimize total cost, since only costs are given."). If both cost and revenue are present, state whether you use "minimize cost" or "maximize profit". Ask the user if unclear.

### Parsing workflow

1. **Split** the problem text into sentences or logical clauses.
2. **Label** each: parameter/given | constraint | decision | **objective** (if stated).
3. **Identify the objective (explicit or implicit):** If the problem says "minimize/maximize X", that's the objective. If it only says "determine the plan" (or "find", "establish") but gives costs (and possibly revenues), the objective is **implicit** — state it (e.g., minimize total cost, or maximize profit) and confirm with the user if ambiguous.
4. **Flag implicit constraints**: For each sentence, ask — "Does this state a fixed fact or a requirement (→ parameter/constraint), or something we choose (→ decision)?"
5. **Resolve ambiguity** by checking verbs and modals:
   - "is", "has", "operates", "employs", "plans to" (fixed/committed) → parameter or implicit constraint.
   - "may", "can choose", "considers", "decides", "wants to" (optional) → decision or objective.
6. **🔒 MANDATORY — If anything is still ambiguous** (e.g., a value or constraint could be read two ways): ask the user which interpretation is correct, or solve all plausible interpretations and report all outcomes. Do not assume a single interpretation.
7. **Summarize** for the user: list parameters, constraints (explicit + flagged implicit), decisions, and **objective (explicit or inferred)** before writing the math formulation.

### Parsing checklist

- [ ] Every sentence has a label (parameter | constraint | decision | objective if stated).
- [ ] **Objective is identified:** Explicit ("minimize/maximize X") or implicit ("determine the plan" + costs → minimize total cost; + revenues → maximize profit). Never formulate without stating the objective.
- [ ] Committed phrasing ("plans to", "operates", "employs") → not decisions.
- [ ] Optional phrasing ("may", "can choose", "considers") → decisions.
- [ ] Implicit constraints from committed phrasing are written out (e.g., "all X must be produced").
- [ ] **🔒 MANDATORY — Ambiguity:** Any phrase that could be read two ways → I asked the user or I will solve all interpretations and report all outcomes (no silent single interpretation).
- [ ] Summary is produced before formulating (parameters, constraints, decisions, **objective**).

### Example

**Text:** "The company operates 3 factories and plans to produce 500 units. It may use overtime at extra cost. Minimize total cost."

| Sentence / phrase | Label | Note |
|-------------------|-------|------|
| "Operates 3 factories" | Parameter | All 3 open; not facility selection. |
| "Plans to produce 500 units" | Constraint (implicit) | All 500 must be produced. |
| "May use overtime at extra cost" | Decision | How much overtime is a decision. |
| "Minimize total cost" | Objective | Drives decisions. |

Result: Parameters = 3 factories, 500 units target. Constraints = produce exactly 500 (implicit from "plans to produce"). Decisions = production allocation across factories, overtime amounts. Objective = minimize cost.

**Implicit-objective example:** A problem that asks to "determine the production plan" (or similar) and gives cost components (e.g., workshop, inspection, sales) but does not state "minimize" or "maximize" → **Objective is implicit: minimize total cost**. Always state it explicitly: "The objective is to minimize total cost."

---

## QP rule: minimize only

QP objectives must be **minimization**. To maximize a quadratic expression, negate it and minimize; then negate the optimal value.

For minimization to be well-posed, the quadratic form `Q` should be positive semi-definite. If `Q` is indefinite, the problem is non-convex and may not have a finite optimum.

---

## Common patterns

The remaining sections cover specific LP/MILP modeling patterns. Each is independent — read the one that matches your problem.

### Piecewise-linear objectives with integer production

When modeling **concave piecewise-linear** profit/cost functions (e.g., decreasing marginal profit for bulk sales), the standard approach uses continuous segment variables with upper bounds equal to each segment's width. For a maximization with concave profit, the solver fills higher-profit segments first naturally.

**Gotcha:** If the quantity being produced is discrete (pieces, units, items), the **total production** variable must be **INTEGER**, even though segment variables can remain **CONTINUOUS**. Without this, the LP relaxation may yield a fractional total that produces a different (higher or lower) objective than the true integer optimum.

#### Pattern

```
x_total  — INTEGER (total production of a product)
s1, s2, … — CONTINUOUS (amount sold in each price segment, bounded by segment width)

Link: x_total = s1 + s2 + …
Resource constraints use x_total.
Objective uses segment variables × segment profit rates.
```

### Cutting stock / trim loss problems

In cutting stock problems, **waste area** includes both **trim loss** (unused width within each cutting pattern) and **over-production** (excess strips produced beyond demand). Minimizing only trim loss (waste width × length per pattern) ignores over-production and yields an incorrect objective.

#### Correct objective

Since the total useful area demanded is a constant, minimizing waste is equivalent to minimizing total material area consumed:

```
minimize  sum_j (roll_width_j × x_j)
```

where `x_j` is the length cut using pattern `j`. The waste area is then:

```
waste = total_material_area − required_useful_area
```

where `required_useful_area = sum_i (order_width_i × order_length_i)`.

#### Gotcha

Using `sum_j (waste_width_j × x_j)` as the objective only captures trim loss — the unused strip within each pattern. It does **not** penalize over-production of an order. The solver will over-produce narrow orders to fill patterns efficiently, but that excess material is still waste. Always use total material area as the objective.

### Goal programming (preemptive / lexicographic)

Goal programming optimizes multiple objectives in priority order. Implement it as **sequential solves** — one per priority level.

#### Formulation pattern

1. **Hard constraints** — capacity limits, non-negativity, etc. These hold in every phase.
2. **Goal constraints** — for each goal, introduce deviation variables (d⁻ for underachievement, d⁺ for overachievement) and write an equality: `expression + d⁻ − d⁺ = target`.
3. **Solve sequentially by priority:**
   - Phase 1: minimize (or maximize) the relevant deviation for the highest-priority goal.
   - Phase k: fix all higher-priority deviations at their optimal values, then optimize priority k's deviation.

#### Variable types in goal programming

Deviation variables (d⁻, d⁺) and slack/idle-time variables are always **continuous**. However, **decision variables must still be INTEGER when they represent discrete/countable quantities** (units produced, vehicles, workers, etc.). Do not let the presence of continuous deviation variables cause you to make all variables continuous — the integrality of decision variables directly affects feasibility and objective values.

### Multi-period inventory / purchasing models

In problems with buying, selling, and warehouse capacity over multiple periods, decide which capacity constraints to include based on the problem's timing assumptions.

#### Pattern

For each period *t* with inventory balance `stock[t] = stock[t-1] + buy[t] - sell[t]`:

- **End-of-period capacity** (variable bound): `stock[t] <= capacity` — always needed.
- **After-purchase capacity** (explicit constraint): `stock[t-1] + buy[t] <= capacity` — prevents buying more than the warehouse can hold before any sales occur within the period.

#### When to include the after-purchase constraint

- **Include it** when the problem states or implies that purchases are received before sales happen within a period (sequential operations), or when the warehouse physically cannot exceed capacity at any instant.
- **Omit it** when buying and selling are concurrent within a period (common in textbook trading/inventory problems) and the capacity applies only to end-of-period stock. Many classic problems only constrain end-of-period inventory.

**Key interaction with the sell constraint:** If the model already has `sell[t] <= stock[t-1]` (grain bought this period cannot be sold this period), the model is bounded even without the after-purchase constraint. The sell constraint prevents unbounded buy-sell cycling. The after-purchase constraint is then an additional physical restriction, not a mathematical necessity.

**Default:** If the problem does not specify timing within a period, use **only** end-of-period capacity (`stock[t] <= capacity`). Add the after-purchase constraint only if the problem explicitly requires it.

### Blending with shared mixing / intermediate processing

In some blending problems, a subset of raw materials must be **mixed together first** (e.g., in a mixing tank) before being allocated to different products. The resulting intermediate has a **uniform composition** — you cannot independently assign different raw materials to different products.

#### Why the standard blending LP is wrong here

The standard blending LP uses variables `x[i][j]` (amount of raw material `i` in product `j`) and freely allocates each raw material to each product. When raw materials share a mixing step, the proportions of those raw materials must be **identical** in every product that receives the intermediate. This proportionality constraint is **bilinear** (`x[A,1]*x[B,2] = x[B,1]*x[A,2]`) and cannot be directly expressed in an LP.

#### Linearization strategies

1. **Single-product allocation:** If analysis shows the intermediate is profitable in only one product, allocate all intermediate to that product (set intermediate allocation to other products to zero). The proportionality constraint becomes trivially satisfied. This is the most common case — check profitability of intermediate in each product before attempting a general split.

2. **Parametric over intermediate concentration:** Fix the sulfur/quality concentration of the intermediate as a parameter `σ`. For each fixed `σ`, the problem is a standard LP (intermediate becomes a virtual raw material with known properties). Solve for a grid of `σ` values or use the structure to find the optimum analytically.

3. **Scenario enumeration:** When only 2–3 products exist, enumerate which products receive the intermediate (all-to-A, all-to-B, split). For each scenario with a single recipient, the LP is standard. For split scenarios, use strategy 2.

#### Profitability check

Before formulating, check whether using the intermediate in each product is profitable:
- Compare the **minimum cost per ton** of the intermediate (using cheapest feasible raw material mix) against each product's **selling price**.
- If `cost_intermediate > sell_price[j]` for some product `j`, the intermediate should not be allocated to product `j`. Raw material C (or other direct inputs) alone may also be unprofitable if `cost_C > sell_price[j]`.
- This analysis often eliminates the need for a bilinear split entirely.
