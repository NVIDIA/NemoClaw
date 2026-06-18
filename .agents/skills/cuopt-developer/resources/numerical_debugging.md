# Debugging Numerical Issues in Numerical Optimization Solver Internals

Read this when a solver bug surfaces as **wrong-but-plausible output** rather
than a crash or assertion.

## Symptoms

- A lower bound that contradicts a known incumbent (LP claims a value the MIP
  cannot reach).
- Dual values of order `1e10+` on a problem whose data is `O(1)`–`O(1e5)`.
- A 10× blow-up in simplex iterations after an algorithmic change that should
  have been cheap.
- Bit-for-bit reproducibility of the wrong answer across runs — the bug is
  deterministic, not a memory or race issue.

The root cause is often **catastrophic cancellation** in a
floating-point accumulator: `final = Σ(signed contributions)` collapses to a
value many orders of magnitude smaller than its constituents, leaving the
result dominated by floating-point noise.

## Methodology — Instrument Before Patching

The classical mistake is to guess the cancellation site and apply a fix. There
are usually several candidates and you will guess wrong. Do this instead:

### Locate the suspicious region

Usually a recent commit or a code path tied to the symptom. Read it end-to-end before adding any instrumentation.

### Audit candidate cancellation sites by hand

Any floating-point accumulator whose result can be much smaller than its inputs is a candidate.
Write the list down before you instrument anything.

### Instrument each site with a `cancel_ratio = |final| / max(1, Σ|delta|)`

Logged per event. A ratio of `1.0` means no cancellation; `1e-9` means ~7 decimal digits of precision lost; `1e-15` means the result is numerical noise.

### Reproduce, log, read

Sort the log by `cancel_ratio` ascending; the worst offenders are at the top.

### Guard at the exact site that's cancelling — not earlier, not later

A guard on an upstream accumulator does nothing if cancellation happens downstream; cut-generation paths typically have multiple sites in series.

### Re-run and confirm

If the symptom persists, your instrumentation missed a site — return to step 2. The cancellation hypothesis is wrong only if every measured ratio is `≥ ~1e-6` and the symptom is still there.

## Threshold Guidance

A cancellation ratio of `1e-9` leaves ~7 decimal digits of precision in a
double. Use this as the *machine-safety* floor — a guard at this level only
rejects results that are essentially noise.

A ratio of `1e-4` leaves ~12 digits, which is still numerically clean but
tight enough that downstream LP solves remain conditioned. Use this for guards
on quantities that feed back into a basis whose conditioning matters (cut
RHS, constraint accumulators, anything that becomes a row of `A` after
addition).

When in doubt, log the ratio *without* filtering first, observe the
distribution across a representative benchmark, and place the threshold at
least one order of magnitude below the cleanest "bad" case and at least one
order of magnitude above the cleanest "good" case. Single-instance threshold
choices tend to over-fit.

## Cancellation Sites in Cut Generation

Cut-generation routines (Gomory, MIR, complemented-MIR, flow-cover) are
repeat offenders. They build a cut by combining row data with variable-bound
substitutions, each of which can introduce a large
`coefficient × bound_bias` shift. The shifts often sum to a small residual.

In a cMIR-style routine, expect **three accumulators in series**, each
capable of independent cancellation:

| # | Accumulator | Cancellation form |
|---|---|---|
| 1 | Substituted row RHS | `b − Σ (coef × variable_bound_bias)` |
| 2 | Cut-LHS constant | `Σ (multiplier × per_arc_constant)` across all arcs |
| 3 | Final cut RHS subtraction | `cut.rhs = lhs_constant − substituted_b` |

Two of the three can have well-behaved ratios individually while the third
still cancels — site (3) is especially insidious because both inputs can be
clean on their own and only their *difference* loses precision. A guard at
only one site is insufficient; instrument all three before deciding where to
clamp.

## Scale-Mismatch Hazard

A cut that is mathematically valid by construction can still poison the LP
basis after addition. If `cut.rhs` is several orders of magnitude below the
original constraint matrix's typical row scale, the dual simplex needs to
produce dual values at the inverse scale to express dual feasibility, and
those duals propagate into the bound.

The diagnostic for this is **iteration count**, not the cut shape.
Re-optimization after cut addition should take `O(few ×)` the original root
iterations. If it suddenly takes `O(10×)`, the cuts are valid but
ill-conditioned for the LP.

Filters that help, in order of increasing aggressiveness:

- Reject cuts with high coefficient dynamism (`max|coef| / min|coef|`).
- Reject cuts with `|cut.rhs|` much smaller than the original row scale on
  the source row.
- Suppress variable-bound substitutions whose bias term is itself huge —
  root-cause filter, but rejects more cuts than necessary.

Pick the lowest-risk filter that removes the symptom on the failing instance.
Re-validate on the broader benchmark before declaring the fix done — a guard
that fixes one instance can quietly suppress healthy cuts on others.

## Common Mistakes

- **Speculative fix before measurement.** "It's probably the MIR floor at
  large ratios" is a guess. Instrument first; the data usually points
  elsewhere.
- **Single global guard.** A guard at the first cancellation site won't catch
  the rest. Cut paths typically have 2–3 distinct sites in series.
- **Confusing "small final value" with "cancellation."** A small `final`
  derived from a small sum of small `delta_i` is healthy. The ratio
  `|final| / Σ|delta_i|` is what distinguishes the two.
- **Picking the most aggressive (root-cause) filter when a narrow site-guard
  would do.** Be surgical; the narrowest filter that recovers correctness is
  the right one.
