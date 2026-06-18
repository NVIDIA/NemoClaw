<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Instance-Candidate Finder — Behavioral Specification

Status: draft (revision 3 - pairs the read-only finder with a rewrite-tool spec)
Audience: a coding agent (or human) re-implementing the tool from scratch
Style: behavior-only. Do not infer function names, class layout, or module
structure from this document. Any implementation that satisfies every clause
in [§13 Acceptance Criteria](#13-acceptance-criteria) is correct.

---

## 1. Purpose

A read-only analysis tool that scans a USD sub-hierarchy and reports
sub-hierarchies that occur multiple times and could be made `instanceable`.
For each reported group it also classifies how cleanly that group could be
turned into a shared prototype, based on outgoing references from inside the
subtree.

The tool **does not modify the stage**. The actual de-duplication step
(rewriting the stage to use shared prototypes) is a separate tool described in
`skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/apply-restructure/references/hierarchy-dedupe-rewrite-tool-spec.md`.

Treat the finder output as the input packet for a USD authoring rewrite that
creates prototype assets or internal prototype prims and then rewrites
duplicates as references.

Related prior art in this repository (informational, not a dependency):
`source/tests/test.pythonBindings/test_validators_duplicate_geometry.py`,
`test_validators_fuzzy_duplicate_geometry.py`, and
`test_operation_organize_prototypes.py`. This spec describes a
hierarchy-level analyzer, not a per-mesh dedup or a prototype-organizer.

## 2. Runtime context

- Single self-contained Python script.
- Designed to be pasted into the Omniverse Kit Script Editor and run once.
- Operates on the currently-open USD stage retrieved from the Kit USD context.
- Uses only `pxr` and the Python standard library.
- Output is plain text written to stdout / the script editor console.
- No file I/O, no UI, no asynchronous work.

## 3. Inputs

A single configuration block at the top of the script. All values must be
trivially editable by a user before they paste-and-run, as literal Python
assignments (not nested dicts).

### 3.1 Knobs

- **`ROOT`** *(string, USD path)* — the prim under which to search. The
  tool considers `ROOT` itself and all of its descendants. `ROOT = "/"`
  is permitted; the pseudo-root is treated like any other prim and walked
  normally.
- **`HASH_LEVEL`** *(integer, 1..4)* — fidelity of the duplicate-detection
  hash. See [§5 Hash levels](#5-hash-levels) for exact semantics.
- **`MIN_SUBTREE_PRIMS`** *(integer ≥ 1)* — exclude any candidate whose
  subtree (root + descendants) has fewer than this many prims. Subtree
  size is the count of prims that would be hashed for that subtree, with
  the instance-skipping rule from §4 applied (see §9 for the formula).
- **`MIN_DUPLICATE_COUNT`** *(integer ≥ 2)* — only report groups with at
  least this many copies.
- **`TOP_N`** *(integer ≥ 1)* — only print the top N groups, ranked by
  estimated prim savings. All other groups are still counted in totals.
- **`SHOW_PATHS_PER_GROUP`** *(integer ≥ 1)* — per group, print at most
  this many candidate paths; overflow is summarized as "... and K more".
- **`SKIP_EXISTING_INSTANCES`** *(bool)* — see §4.
- **`COLLAPSE_NESTED`** *(bool)* — see §6.4.
- **`CHECK_INSTANCEABILITY`** *(bool)* — when true, run the analysis in §7
  and include verdicts and findings in the report.
- **`MAX_FINDINGS_PER_GROUP`** *(integer ≥ 1)* — max number of finding
  lines printed per group when `CHECK_INSTANCEABILITY` is true.
- **`INCLUDE_ATTRIBUTE_CONNECTIONS`** *(bool)* — when true, attribute
  `.GetConnections()` are checked alongside relationships in §7. When
  false, only relationships are checked.

### 3.2 Defaults

The tool must run with no edits and produce a meaningful report. The
mandatory defaults are:

| Knob                          | Default       | Rationale                                      |
| ---                           | ---           | ---                                            |
| `ROOT`                        | `"/"`         | Whole stage; user almost always narrows it.    |
| `HASH_LEVEL`                  | `3`           | Values matter for real dedup; samples don't usually distinguish identical assets. |
| `MIN_SUBTREE_PRIMS`           | `3`           | Single-prim "groups" are noise.                |
| `MIN_DUPLICATE_COUNT`         | `2`           | The minimum that "duplicate" can mean.         |
| `TOP_N`                       | `25`          | Fits in one screen of console output.          |
| `SHOW_PATHS_PER_GROUP`        | `8`           | Enough paths to spot patterns; overflow trails. |
| `SKIP_EXISTING_INSTANCES`     | `True`        | Already-instanced prims are noise for this analysis. |
| `COLLAPSE_NESTED`             | `True`        | Reporting parent + child duplicate groups is redundant. |
| `CHECK_INSTANCEABILITY`       | `True`        | Verdicts are usually wanted; cheap to compute. |
| `MAX_FINDINGS_PER_GROUP`      | `6`           | Enough to diagnose; not enough to drown the report. |
| `INCLUDE_ATTRIBUTE_CONNECTIONS` | `False`     | Shade-graph traffic is noisy; opt-in keeps the default report focused. |

### 3.3 Validation

If any knob is set to a value outside its declared range or type, the tool
must print a single error line naming the offending knob and exit cleanly
without producing any other report content. The error path is the same as
the missing-`ROOT` path in §8.1.

## 4. Stage traversal rules

- The traversal universe is `ROOT` and all of its descendants on the
  composed stage.
- If `SKIP_EXISTING_INSTANCES` is true:
  - Any prim where `IsInstance()` returns true is treated as an opaque
    leaf for hashing purposes (its descendants are not walked).
  - Such a prim is also ineligible to appear as a candidate root in the
    duplicate report (its prototype is already shared, so reporting it
    would be misleading).
  - For hashing, an instance contributes a **stable identifier derived
    from its prototype path and its prim type**, used identically in
    both the full hash and the candidate hash. Any local opinions at the
    instance site (xformOps, metadata, locally-authored attributes) are
    intentionally ignored when the instance is acting as an opaque leaf.
    Two instances of the same prototype must therefore hash equal.
- If `SKIP_EXISTING_INSTANCES` is false:
  - The tool descends into instance-proxy children using
    `Usd.TraverseInstanceProxies`. Behavior on proxies is otherwise the
    same as for normal prims, except that proxies are read-only (the
    tool never writes anyway).
  - Authored properties on proxies are consulted via composition (i.e.
    `prim.GetAuthoredAttributes()` returns the prototype's authored
    attributes). No special handling distinguishes proxies from
    natively-authored prims for the purpose of hashing.
- Inactive prims (`prim.IsActive()` false) are skipped entirely. They
  do not contribute to any ancestor's hash and they never appear as a
  candidate root.
- Abstract prims (`prim.IsAbstract()` true) are skipped entirely.
- Class prims (`Sdf.SpecifierClass`) are skipped entirely.

## 5. Hash levels

For every prim in the traversal universe the tool computes a **full hash**
that uniquely identifies the composed content of that prim's subtree at
the chosen fidelity level. Two subtrees with equal full hashes must be
treated as content-equal at that fidelity.

The tool also computes a **candidate hash** per prim (see §6.2) which is
what cross-prim grouping is performed on.

Fidelity levels are cumulative — each level includes everything from the
levels below it.

### Level 1 — Topology
Captures, for every prim in the subtree:

- the prim type name
- the prim's name (relative within the subtree — see §6.2 for treatment of
  the candidate-root's own name)
- the ordered list of children's hashes (children must be enumerated in
  USD authored order, never reordered)

### Level 2 — Topology + authored attribute schema
Adds, per prim, the sorted list of `(attribute_name, attribute_type_name)`
for every attribute that has an authored value at the current edit target /
composed view. The sort makes hash output insensitive to the author-order
of attribute declarations.

### Level 3 — Topology + attribute schema + values
Adds, per prim, the actual default values of every attribute that has an
authored value. Time samples are *not* included at this level; only the
default value is.

### Level 4 — Full
Adds, per prim:

- For every attribute with an authored value: the **sorted list of sample
  times AND the value at each sample time**. (Sample times alone would
  not be enough to call two subtrees observably interchangeable; this
  level captures both.)
- Every authored relationship's name and the ordered list of its targets
  as composed paths.

Level 4 is the strictest level the tool offers. If two subtrees hash equal
at level 4 they are observably interchangeable for the purposes of
instancing.

### 5.1 Long-value digesting (mandatory)

Any value that would otherwise be embedded in a hash input as a long string
**must** be substituted with a digest first. The thresholds are:

- Any value whose Python `repr()` exceeds **256 bytes**, OR
- Any array-typed value of length ≥ **16**

Substitution form: the literal value is replaced in the hash input by the
string `"<digest:HEX>"` where `HEX` is the lowercase hex digest of a
deterministic canonical serialization of the value (sha256 of the value's
raw bytes, or of `repr(value)` for non-array values, is acceptable). The
substitution function must be:

- Deterministic: equal values map to equal digests in the same process and
  across processes on the same Python interpreter version.
- Injective enough: collisions must be cryptographically negligible for
  realistic USD content (sha256 or stronger).

## 6. Duplicate detection

### 6.1 Full hash
Computed once per prim, post-order (children-first), and memoized so each
prim's subtree is hashed exactly once. The full hash of `ROOT` is computed
and discarded — `ROOT` itself is never reported as a candidate.

### 6.2 Candidate hash
For each prim P (other than `ROOT`), derive a candidate hash that
represents "the prototype P would become". The candidate hash differs
from the full hash in exactly two ways:

- P's own prim **name** is excluded. (Two equivalent subtrees may live
  under different parent paths with different leaf names.)
- P's own `xformOpOrder` and any attribute whose name begins with
  `xformOp:` are excluded. (Those represent placement, which is per-instance,
  not part of the prototype.)

Everything else about P — its prim type, its other authored attributes,
and the full hashes of all its children — is included.

`xformOp:*` and `xformOpOrder` on **descendants** of P are *not* excluded;
they are part of the prototype. Only the candidate-root's own placement
is excluded. Two subtrees that differ only in a descendant's local xform
are different prototypes and therefore different groups.

Descendant prim names are likewise *not* excluded. Two subtrees that
differ only in the names of their internal prims are not equivalent
prototypes.

### 6.3 Grouping and ranking
- Group all eligible prims by candidate hash.
- A group is reported if it has at least `MIN_DUPLICATE_COUNT` members and
  every member's subtree has at least `MIN_SUBTREE_PRIMS` prims. (Members
  of the same group always have the same subtree size by construction;
  the check is one comparison per group.)
- A group's **estimated prim savings** is `subtree_prims * (copies - 1)`.
- Groups are sorted in descending order of estimated prim savings. Ties
  are broken first by larger `subtree_prims`, then by ascending candidate
  hash string. (Any deterministic tie-break is acceptable as long as it
  does not depend on Python's hash randomization or insertion order of
  unrelated dicts.)

### 6.4 Nested-group collapse
When `COLLAPSE_NESTED` is true, after sorting:

- Walk groups in order, keeping a running set of "kept root paths".
- A group is *dropped* if every one of its candidate root paths is a
  strict descendant of some path already in the kept set.
- A group is *kept* otherwise; its candidate root paths are added to the
  kept set.

The intent: making the parent group instanceable absorbs the child group;
reporting both is redundant.

When `COLLAPSE_NESTED` is false, no such filtering is applied.

## 7. Instanceability check (when `CHECK_INSTANCEABILITY` is true)

Run after grouping (and after collapse, if applicable). For each
*reported* group, classify the group's instanceability based on outgoing
references from inside the subtree.

### 7.1 What is collected
For each candidate root R in the group, walk R and all descendants and
collect, per visited prim D (which may be R itself):

- Every authored relationship on D, as `(D, rel_name, [target, ...])`.
- If `INCLUDE_ATTRIBUTE_CONNECTIONS` is true: every authored attribute on
  D whose `.GetConnections()` is non-empty, as `(D, attr_name, [target, ...])`.

A reference is keyed by its **relative property key** within R, formed
as follows:

- Let `rel_path` = the path from R to D, with R itself stripped. If D == R,
  `rel_path` is the empty string.
- The key is `rel_path + "." + property_name`.

Worked examples (R rendered for clarity; not part of the key):

| Where the property lives                        | Property name      | Key                          |
| ---                                             | ---                | ---                          |
| R itself, relationship                          | `material:binding` | `.material:binding`          |
| `R/Geom`, relationship                          | `material:binding` | `/Geom.material:binding`     |
| `R/Mat`, attribute connection (when enabled)    | `inputs:diffuse`   | `/Mat.inputs:diffuse`        |
| `R/A/B/C`, relationship                         | `proxyPrim`        | `/A/B/C.proxyPrim`           |

USD prim properties share a single namespace (a relationship and an
attribute on the same prim cannot share a name), so the key namespace
needs no `rel:` / `conn:` prefix.

A target is normalized to one of:

- `INTERNAL` if the target's prim portion is at or below R, with the
  **relative-to-R form of the target path** stored alongside (the
  property suffix on the target, if any, is preserved verbatim).
- `EXTERNAL` otherwise, with the **absolute composed path** stored
  alongside (again, property suffix preserved).

Targets returned by `Usd.Attribute.GetConnections()` may include a
property segment (e.g. `/A/B.diffuse`). Such targets are classified by
their prim portion (`/A/B`); the property suffix is preserved as part
of the stored target value for evidence reporting only.

Empty target lists are not collected (they carry no information for this
analysis).

### 7.2 Per-key classification

For each relative property key that appears on at least one copy:

- **INTERNAL** — *all* of the following hold:
  - The property is authored on every copy in the group.
  - Every target on every copy is `INTERNAL` (kind).
  - The full sequence of relative-to-R target paths (and any preserved
    property suffixes) is identical across all copies. Order matters —
    a target list of `[A, B]` on one copy and `[B, A]` on another is
    *not* identical.
- **CONSISTENT_EXTERNAL** — *all* of the following hold:
  - The property is authored on every copy in the group.
  - Every target on every copy is `EXTERNAL` (kind).
  - The full sequence of (kind, target_value) tuples is identical across
    all copies. Order matters, as above.
- **INCONSISTENT** — any other situation, including:
  - The property is authored on only some copies.
  - Different copies have differing target sequences.
  - A mix of `INTERNAL` and `EXTERNAL` targets across copies.
  - A mix of `INTERNAL` and `EXTERNAL` targets within a single copy.

### 7.3 Group verdict
Roll up the per-key classifications:

- **GREEN** if every key is `INTERNAL` (or there are no outgoing
  references at all).
- **YELLOW** if at least one key is `CONSISTENT_EXTERNAL` and no key is
  `INCONSISTENT`.
- **RED** if any key is `INCONSISTENT`.

### 7.4 Material-boundary hints

Material bindings and UsdShade shader connections that cross the candidate
root are common and should be surfaced distinctly in findings. A group with
otherwise matching subtrees and `CONSISTENT_EXTERNAL` material targets is still
reported as YELLOW, but the finding should say that the rewrite can usually
inline the local material network into the prototype.

The finder is read-only, so it does not decide whether two external material
paths are visually equivalent. It should provide enough evidence for the
rewrite tool to make that decision:

- the relative property key, such as `.material:binding` or
  `/Geom.material:binding`
- the absolute material target path on each copy
- whether all copies target the same path
- if available without expensive traversal, the root material prim type and
  material prim name

If different copies bind to different material paths, keep the finding RED at
the current hash level. The user or rewrite tool may split the group, raise the
hash level, or compare material-network closures before rewriting.

### 7.5 Findings
Per group, produce up to `MAX_FINDINGS_PER_GROUP` finding lines, prioritized
in this order:

1. All `INCONSISTENT` keys (most important to surface).
2. All `CONSISTENT_EXTERNAL` material keys, labeled as inline candidates.
3. Other `CONSISTENT_EXTERNAL` keys.
4. A representative subset of `INTERNAL` keys, only if space remains.

Within each priority bucket, findings must be emitted in **ascending
lexicographic order of the relative property key** (for I1 determinism).

Each finding line must include:

- The relative property key.
- The classification.
- A short evidence summary:
  - `INTERNAL`: the relative-to-R target (the same on every copy).
  - `CONSISTENT_EXTERNAL`: the absolute external target shared by all copies.
  - `INCONSISTENT`: a brief description such as "K of N copies authored,
    M distinct targets" with up to a couple of example targets.

If the number of findings exceeds `MAX_FINDINGS_PER_GROUP`, an "... and K
more findings" trailer must be printed.

## 8. Output format

The tool writes plain text to stdout.

### 8.1 Error path
**If `ROOT` is missing or invalid, OR any knob in §3.1 is out of range,
print exactly one error line naming the problem and exit. No other
content is produced — no startup line, no headers, no footers.**

### 8.2 Normal path
Otherwise, the report **must** present, in this order:

1. A startup line indicating the root being scanned and the active
   `HASH_LEVEL`.
2. A line indicating how many prims were hashed and that grouping has begun.
3. A header line stating the total number of duplicate groups reported,
   with the active filter values (`MIN_SUBTREE_PRIMS`,
   `MIN_DUPLICATE_COUNT`, `HASH_LEVEL`).
4. The top `TOP_N` groups, each rendered as:
   - A header line containing: an index, the candidate hash, the subtree
     prim count, the number of copies, and the estimated prim savings.
   - When `CHECK_INSTANCEABILITY` is true: a verdict line and up to
     `MAX_FINDINGS_PER_GROUP` finding lines as defined in §7.5.
   - Up to `SHOW_PATHS_PER_GROUP` candidate root paths, sorted in
     **ascending lexicographic order of the composed path string** (for
     I1 determinism).
   - If more copies exist than were shown, an "... and K more" trailer line.
5. A summary block at the end containing:
   - **`Total potential prim savings (all groups, after collapse)`** —
     sum of `subtree_prims * (copies - 1)` across every reported group.
   - When `CHECK_INSTANCEABILITY` is true, additionally:
     - **`Clean savings (GREEN+YELLOW)`** — sum of savings of
       non-`RED` groups.
     - **`Blocked savings (RED)`** — sum of savings of `RED` groups, with
       a note recommending the user re-run at `HASH_LEVEL=4` to split
       those groups.
6. A footer with caveats. The footer must explicitly state:
   - The tool is advisory only and does not modify the stage.
   - Outgoing references that point outside a candidate subtree may
     prevent clean instancing.
   - Material bindings that point outside a candidate subtree are common;
     matching local material networks should usually be inlined during the
     rewrite.
   - To distinguish two near-duplicate subtrees, the user can decrease
     `HASH_LEVEL` and observe at which level they merge into one group.
   - When verdicts are reported: GREEN means cleanly instanceable; YELLOW
     means instanceable after reviewing or inlining external dependencies;
     RED means the group as-formed is not actually one prototype and should
     either be split (raise `HASH_LEVEL` to 4) or not be instanced.

### 8.3 Whitespace
The exact wording of headers and delimiters is not prescribed. Blank
lines between sections (and between groups) are permitted and recommended
for readability, but are not required. I1 determinism (§10) only
requires byte-identical output across runs of the *same* implementation;
it does not require parity across different implementations.

## 9. Definitions

- **Subtree of P** — P and the set of prims reached from P by recursive
  descent under the traversal rules in §4.
- **Subtree size** — the number of prims in P's subtree, computed as
  follows:
  - When `SKIP_EXISTING_INSTANCES = True`: each instance encountered
    counts as 1 (its descendants are not walked).
  - When `SKIP_EXISTING_INSTANCES = False`: each instance counts as
    1 + the sum of its proxy children's subtree sizes.
  - Inactive / abstract / class prims do not contribute.
- **Candidate root** — a prim under `ROOT` (excluding `ROOT` itself) that
  is eligible to appear in a group: its subtree size is at least
  `MIN_SUBTREE_PRIMS` and, when `SKIP_EXISTING_INSTANCES` is true, it is
  not itself an instance.
- **Group** — the set of candidate roots that share a candidate hash.
- **Estimated prim savings** — `subtree_prims * (copies - 1)` for a group.
  This represents the count of prims that would no longer need to be
  composed if all copies in the group shared a single prototype. This is a
  useful proxy for stage-load and memory savings; it is not a guaranteed
  performance number.

## 10. Invariants

The implementation must preserve all of these. Acceptance tests in §13
exercise them.

- **I1 — Determinism (single implementation, single host).** Running the
  tool twice on the same stage with the same configuration, in the same
  Python process or in two processes on the same machine running the
  same implementation and Python interpreter version, must produce
  byte-identical output (excluding any wall-clock timestamps the
  implementation chooses to print — none are mandated). This invariant
  does NOT extend to byte parity across different implementations of
  this spec.
- **I2 — Hash equality implies behavioral equality at level.** Two
  subtrees with the same full hash at level L must be indistinguishable
  with respect to everything that level L is supposed to capture. (At
  level 4 this means observably interchangeable for instancing.)
- **I3 — Membership monotonicity in level.** If two subtrees fall into
  the same group at level L, they fall into the same group at every
  level less than L. Equivalently, raising `HASH_LEVEL` can only split
  groups, never merge them.
- **I4 — Savings monotonicity in level.** Raising `HASH_LEVEL` can only
  decrease (or hold) the total reported savings.
- **I5 — Linear hashing cost.** The hashing pass is O(N) in the number
  of prims under `ROOT` (each prim's full hash computed exactly once).
  An implementation that recomputes child subtree hashes per ancestor
  visit is non-conforming.
- **I6 — Read-only.** No layer is opened for write, no prim is created
  or modified, no metadata is authored, no `Sdf.ChangeBlock` is needed.
- **I7 — Verdict monotonicity in `INCLUDE_ATTRIBUTE_CONNECTIONS`.**
  Turning the flag on can only worsen verdicts (GREEN→YELLOW→RED) and
  add findings; it cannot improve them.
- **I8 — Hash invariance under attribute author-order.** At `HASH_LEVEL`
  ≥ 2, the hash must depend only on the *set* of authored attribute
  schemas (and at level ≥ 3, their values), not on the order in which
  they were authored.

## 11. Edge cases

The implementation must handle each of these correctly. None of these
should raise an exception or produce malformed output.

- **`ROOT` does not exist.** Print a single error line naming the missing
  path; produce no other report content; exit cleanly. (See §8.1.)
- **`ROOT` exists but has no descendants.** Print the standard headers
  and a "Duplicate groups: 0" line. Do not error.
- **`ROOT` is itself an existing instance** (with `SKIP_EXISTING_INSTANCES
  = True`). The traversal universe contains only `ROOT`; no prim under it
  is walked; no candidate roots exist; the report shows zero duplicate
  groups. This is a valid silent-zero case, not an error.
- **`ROOT == "/"`** is permitted. The pseudo-root is walked as any other
  prim. Implementations must take care that relative-path computation
  handles the empty-prefix case correctly.
- **Subtree contains only existing instances.** With
  `SKIP_EXISTING_INSTANCES` true, those instances are leaves and won't
  themselves be reported, but they may participate in their ancestors'
  hashes (as opaque leaves keyed on prototype identity).
- **Attribute value is unreadable** (`.Get()` raises). The hash for
  level ≥ 3 must record the attribute name with an `<unreadable>`
  marker rather than aborting the run; this marker counts as a value
  and contributes to hashes deterministically.
- **Attribute connections targeting paths inside an existing instance
  prototype** (`/__Prototype_*` paths) are treated as `EXTERNAL`. They
  will typically classify as `CONSISTENT_EXTERNAL` if all copies share
  the same prototype.
- **Relationship authored with no targets.** Skip; not informative for
  this analysis.
- **A single candidate root with N=1 copy.** Never reported (filtered
  by `MIN_DUPLICATE_COUNT ≥ 2`).
- **A group of N≥2 but with subtree size below `MIN_SUBTREE_PRIMS`.**
  Never reported.
- **A group whose every member is a strict descendant of some larger
  kept group.** Dropped when `COLLAPSE_NESTED` is true; kept otherwise.
- **Long array attribute values** (e.g. mesh point arrays). Must be
  digested per §5.1 before being included in any hash.
- **Variant selections.** The tool reads the composed stage; whatever
  variant is currently selected on each prim is what gets hashed. No
  attempt is made to enumerate variants or vary selections.

## 12. Performance expectations

- **Hashing pass:** O(N) where N is the prim count under `ROOT`. Memory
  proportional to N (one digest plus subtree size per prim).
- **Grouping pass:** O(N) average time, O(G) memory where G is the
  number of distinct candidate hashes.
- **Instanceability pass:** scoped to *reported* groups only (i.e. the
  filtered, sorted, possibly-collapsed list, then trimmed by `TOP_N` for
  printed findings; full totals may compute over all reported groups).
  Cost is bounded by `(groups_reported × avg_copies × avg_subtree_size)`.
- The tool must remain interactive (single-digit seconds) on stages of
  ~10⁵ prims with default settings on commodity hardware. Stages of
  ~10⁶ prims should complete in tens of seconds at level 3.

## 13. Acceptance criteria

A reimplementation is correct if it passes all of these. The tests are
described in plain language; an implementer is free to author them in
any framework.

1. **Trivial empty case.** A stage where `ROOT` exists and has zero
   descendants produces a report with `Duplicate groups: 0` and exits
   cleanly.
2. **Single duplicate.** A stage with two structurally identical
   subtrees of size S under `ROOT`, with no other prims, produces
   exactly one reported group of size 2 with subtree prim count S and
   estimated savings S. With `CHECK_INSTANCEABILITY=True` and no
   relationships in the subtree, the verdict is GREEN.
3. **Different placements still match.** Two subtrees that are
   identical except for the candidate root's own `xformOp:translate`
   value must be reported as the same group at every `HASH_LEVEL`.
4. **Different leaf names do NOT match.** Two subtrees that are
   identical in type and structure but have at least one descendant
   with a different prim name must not be reported as the same group
   at any `HASH_LEVEL`.
5. **Different attribute values match at level 2 but not 3.** Two
   subtrees identical in structure and authored attribute schema but
   with different attribute values must merge into the same group at
   level 2 and split at level 3.
6. **Different time samples match at level 3 but not 4.** Two subtrees
   identical at level 3 but with different time-sample sets (or
   different per-sample values) on at least one attribute must merge
   at level 3 and split at level 4.
7. **Existing instance shielding.** With `SKIP_EXISTING_INSTANCES=True`,
   prims that are already instances are not themselves reported as
   candidates, and their descendants are not walked.
8. **`SKIP_EXISTING_INSTANCES=False` traversal.** A stage with a single
   existing instance whose prototype has 5 prims, scanned with
   `SKIP_EXISTING_INSTANCES=False`, when copied twice (so two instances
   point at the same prototype), reports a duplicate group of size 2
   with `subtree_prims = 5`.
9. **Nested collapse.** Given an outer group of two subtrees of size 10
   and the inner subtrees of size 3 within them (which trivially also
   form a duplicate group), with `COLLAPSE_NESTED=True` the inner group
   is not reported. With `COLLAPSE_NESTED=False` both are reported.
10. **Inactive child omission.** A subtree containing an inactive child
    must hash equal to the same subtree without that child. Two
    subtrees that differ only in whether an inner prim is inactive
    must group together at every `HASH_LEVEL`.
11. **Attribute author-order invariance.** Two subtrees identical in
    structure and in the *set* of authored attribute (name, type, value)
    triples but differing in the order those attributes were authored
    must merge into the same group at every `HASH_LEVEL` ≥ 2.
12. **Instanceability — GREEN.** A group whose subtrees contain only
    internal relationships (or no outgoing references at all) gets
    verdict GREEN.
13. **Instanceability — YELLOW.** A group whose subtrees all bind to
    `/World/Materials/SharedMat` via `material:binding` (with no
    inconsistent or other-external references) gets verdict YELLOW
    and one `CONSISTENT_EXTERNAL` inline-candidate finding for
    `material:binding`.
14. **Instanceability — RED with split.** A stage where four subtrees
    are otherwise identical but bind to two distinct external materials
    (two copies bind to `/World/Materials/A`, two bind to `/Materials/B`),
    scanned at `HASH_LEVEL=3`, reports one RED group of size 4 with one
    `INCONSISTENT` finding for `material:binding`. Re-running at
    `HASH_LEVEL=4` splits the group into two YELLOW groups of size 2 each.
    (Stages with fewer than `2 * MIN_DUPLICATE_COUNT` source copies will
    have one or both splits filtered out by `MIN_DUPLICATE_COUNT` — that
    is correct behavior, not a regression.)
15. **`INCLUDE_ATTRIBUTE_CONNECTIONS` monotonicity (I7).** A group whose
    subtrees contain only `INTERNAL` relationships (verdict GREEN with
    `INCLUDE_ATTRIBUTE_CONNECTIONS=False`) but which also contain
    attribute connections to a shared external shader: turning
    `INCLUDE_ATTRIBUTE_CONNECTIONS` from `False` to `True` must change
    the verdict to YELLOW or RED, and must not change verdicts in the
    opposite direction on any group.
16. **Unreadable attribute does not abort the run.** A stage where one
    attribute's `.Get()` raises must still produce a complete report;
    that attribute contributes the `<unreadable>` marker to its prim's
    hash and the run continues deterministically.
17. **Determinism (I1).** Running the same implementation with the same
    configuration twice on an unchanged stage produces byte-identical
    output.
18. **No mutation (I6).** Stage modification timestamps and authored
    layer contents are unchanged after a run.
19. **Reasonable scaling.** A stage with 10⁵ prims completes at level 3
    in single-digit seconds; at level 4, in tens of seconds. (Numbers
    are guidance, not strict gates — but an implementation that is
    asymptotically worse than O(N) for the hashing pass is non-conforming.)
20. **Out-of-range config rejection.** Setting `HASH_LEVEL = 5` or
    `MIN_DUPLICATE_COUNT = 1` causes the tool to print one error line
    and produce no other output.

## 14. Non-goals

- Modifying the stage in any way.
- Suggesting a *placement* for the shared prototype (i.e. where in
  namespace the new shared prim should live).
- Detecting near-duplicates with tolerances (e.g. mesh point clouds
  that differ by ε). That is fuzzy duplicate detection — a separate
  concern.
- Cross-stage analysis. The tool operates on one stage at a time.
- Materials network analysis beyond connection presence/equality (the
  tool does not normalize Shade graphs).
- Hash stability across stages with semantically identical content.
  Two stages authored differently but composing to the same content
  are not guaranteed to produce identical hash digests; only their
  *grouping outcomes* on a single stage are guaranteed.
- Any kind of cost model beyond "prim count savings". Memory and load
  time are correlated with prim count but not equal to it.

---

## Changelog

- **rev 2** — Incorporates feedback from a clean-room re-implementation.
  Fixes §8/§11 ordering contradiction; tightens §5 Level 4 to include
  sample values; tightens §7.2 INTERNAL classification to require
  matching relative target sequences; adds §3.2 Defaults; promotes long-
  value digesting to mandatory with concrete thresholds (§5.1); adds
  worked example block to §7.1; mandates ascending sort within finding
  buckets and within printed candidate-path lists; clarifies §10 I1
  determinism scope; adds I8; adds §9 subtree-size formula for the
  `SKIP_EXISTING_INSTANCES=False` case; adds §11 entries for `ROOT == "/"`,
  `ROOT`-as-instance, and inactive prim handling; adds §13 acceptance
  tests for `SKIP_EXISTING_INSTANCES=False`, inactive-child omission,
  attribute author-order invariance, `INCLUDE_ATTRIBUTE_CONNECTIONS`
  monotonicity, unreadable attribute, and out-of-range config rejection.
- **rev 1** — Initial draft.
