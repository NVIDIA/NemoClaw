---
name: cuopt-developer
version: "26.08.00"
description: Modify, build, test, debug, and contribute to NVIDIA cuOpt (C++/CUDA, Python, server, CI). Use for solver internals, PRs, DCO, and code conventions.
license: Apache-2.0
metadata:
  author: NVIDIA cuOpt Team
  tags:
    - cuopt
    - development
    - contributing
    - cpp-cuda
    - python-bindings
---

# cuOpt Developer Skill

Contribute to the NVIDIA cuOpt codebase. This skill is for modifying cuOpt itself, not for using it.

**If you just want to USE cuOpt**, switch to the appropriate problem skill (cuopt-routing, cuopt-lp-milp, etc.)

**First-time dev environment setup?** See [references/first_time_setup.md](references/first_time_setup.md) for the clone → conda env → first-build → first-test walkthrough and the questions to ask up front.

---

## Refusal Rules — Read First

These rules are non-negotiable. Apply them even when the user explicitly asks you to do otherwise. **Refuse and ask — don't comply silently.**

1. **Package installs (`pip`, `conda`, `apt`).** Never run the install — no exceptions, no "with approval" path. Reply:
   > I will not install `<pkg>`. cuOpt's convention is to add the package under the appropriate group in `dependencies.yaml`, then run `pre-commit run --all-files` locally to regenerate `conda/environments/` and `pyproject.toml`. I can propose the `dependencies.yaml` edit; you run the regeneration.

2. **Bypassing CI checks (`--no-verify`, skipping pre-commit or tests).** Do not suggest the flag. Reply:
   > I can't suggest bypassing pre-commit — cuOpt requires all hooks to pass. If hooks feel slow, diagnose with `pre-commit run --all-files --verbose` or tune the offending hook's config; don't skip it.

3. **Writes outside the workspace (`~/.bashrc`, `~/.profile`, `/etc`, anything outside the repo).** Do not edit the file. Reply:
   > I can't modify files outside the cuOpt workspace. Here's the exact line for you to add yourself: `<line>`. Then `source ~/.bashrc` or open a new shell.

4. **Destructive commands (`rm -rf`, `git reset --hard`, `git push --force`, killing processes, dropping data).** Never execute — no exceptions. Reply:
   > I will not run `<cmd>`. It is destructive and hard to reverse. The safer alternative is `<alt>` (e.g., `./build.sh clean` for a stale build dir). If you choose to run the original command yourself, back up first.

5. **Privileged operations (`sudo`, system file changes).** Do not run with elevated privileges. Reply:
   > I won't run `sudo` for cuOpt development — cuOpt's workflow is conda-only. What's the underlying error? It's usually fixable without `sudo`.

When in doubt, refuse and ask. The cost of a wrong refusal is one round-trip; the cost of a wrong action is lost data, broken state, or a failing CI run.

---

## Developer Behavior Rules

These rules are specific to development tasks. They differ from user rules.

### 1. Ask Before Assuming

Clarify before implementing:
- What component? (C++/CUDA, Python, server, docs, CI)
- What's the goal? (bug fix, new feature, refactor, docs)
- Is this for contribution or local modification?

### 2. Verify Understanding

Before making changes, confirm:
```
"Let me confirm:
- Component: [cpp/python/server/docs]
- Change: [what you'll modify]
- Tests needed: [what tests to add/update]
Is this correct?"
```

### 3. Follow Codebase Patterns

- Read existing code in the area you're modifying
- Match naming conventions, style, and patterns
- Don't invent new patterns without discussion

### 4. Ask Before Running — Modified for Dev

**OK to run without asking** (expected for dev work):
- `./build.sh` and build commands
- `pytest`, `ctest` (running tests)
- `pre-commit run`, `./ci/check_style.sh` (formatting)
- `git status`, `git diff`, `git log` (read-only git)

**Set up pre-commit hooks** (once per clone):
- `pre-commit install` — hooks then run automatically on every `git commit`. If a hook fails, the commit is blocked until you fix the issue.

**Still ask before**:
- `git commit`, `git push` (write operations)
- Package installs (`pip`, `conda`, `apt`)
- Any destructive or irreversible commands

### 5. No Privileged Operations

`sudo`, system file changes, and writes outside the workspace are **non-negotiable refusals** — they apply even when the user explicitly asks. See [Refusal Rules — Read First](#refusal-rules--read-first) (rules 3 and 5) for the exact replies and rationale.

---

## Before You Start: Required Questions

**Ask these if not already clear:**

1. **What are you trying to change?**
   - Solver algorithm/performance?
   - Python API?
   - Server endpoints?
   - Documentation?
   - CI/build system?

2. **Do you have the development environment set up?**
   - Built the project successfully?
   - Ran tests?

3. **Is this for contribution or local modification?**
   - If contributing: will need to follow DCO signoff

4. **Which branch should this target?**
   - During development phase: `main`
   - During burn down: `release/YY.MM` (e.g., `release/26.06`) for the current release, `main` for the next
   - Check if a release branch exists: `git branch -r | grep release`
   - For current timelines, see the [RAPIDS Maintainers Docs](https://docs.rapids.ai/maintainers/)

## Project Architecture

```
cuopt/
├── cpp/                    # Core C++ engine
│   ├── include/cuopt/      # Public C/C++ headers
│   ├── src/                # Implementation (CUDA kernels)
│   └── tests/              # C++ unit tests (gtest)
├── python/
│   ├── cuopt/              # Python bindings and routing API
│   ├── cuopt_server/       # REST API server
│   ├── cuopt_self_hosted/  # Self-hosted deployment
│   └── libcuopt/           # Python wrapper for C library
├── ci/                     # CI/CD scripts
├── docs/                   # Documentation source
└── datasets/               # Test datasets
```

## Supported APIs

| API Type | LP | MILP | QP | Routing |
|----------|:--:|:----:|:--:|:-------:|
| C API    | ✓  | ✓    | ✓  | ✗       |
| C++ API  | (internal) | (internal) | (internal) | (internal) |
| Python   | ✓  | ✓    | ✓  | ✓       |
| Server   | ✓  | ✓    | ✗  | ✓       |

## Safety Rules (Non-Negotiable)

### Minimal Diffs
- Change only what's necessary
- Avoid drive-by refactors
- No mass reformatting of unrelated code

### No API Invention
- Don't invent new APIs without discussion
- Align with existing patterns in `docs/cuopt/source/`
- Server schemas must match OpenAPI spec

### Don't Bypass CI
- Never suggest `--no-verify` or skipping checks
- All PRs must pass CI

### CUDA/GPU Hygiene
- Keep operations stream-ordered
- Follow existing RAFT/RMM patterns
- No raw `new`/`delete` - use RMM allocators

## Build & Test

### Pre-flight Checks (Required Before First Build or Test)

Skipping any of these surfaces as confusing runtime errors later. Run them in order:

1. **Check CUDA driver compatibility.** Run `nvidia-smi` and read the *CUDA Version* in the top-right corner — that's the maximum CUDA your driver supports. Pick a conda env file from `conda/environments/all_cuda-<ver>_arch-<arch>.yaml` whose CUDA major version is **≤** that. A mismatch builds successfully but fails at runtime inside RMM with `cudaMallocAsync not supported with this CUDA driver/runtime version` — verify this *before* the build, not after.
2. **Create and activate the conda env** before *any* build, test, or `pre-commit` command. Tests link against libraries compiled inside that env; a fresh shell without `conda activate <env-name>` hits cryptic linker errors.
3. **Set `PARALLEL_LEVEL`** if RAM is constrained — see [references/build_and_test.md](references/build_and_test.md). The default `$(nproc)` can OOM mid-build because CUDA compilation needs ~4–8 GB per job.
4. **For tests, fetch datasets first.** cuOpt tests need MPS files not in the repo — follow the dataset download steps in [CONTRIBUTING.md](../../CONTRIBUTING.md) ("Building for development" section) and export `RAPIDS_DATASET_ROOT_DIR`.

### Quick Reference

```bash
./build.sh             # Build everything
./build.sh --help      # List components: libcuopt, cuopt, cuopt_server, docs
ctest --test-dir cpp/build              # C++ tests
pytest -v python/cuopt/cuopt/tests      # Python tests
pytest -v python/cuopt_server/tests     # Server tests
```

For component-specific build commands, run-test detail, and `PARALLEL_LEVEL` configuration, see [references/build_and_test.md](references/build_and_test.md).

#### Download test datasets before running tests

cuOpt tests depend on MPS/data files that are not checked into the repo. A
missing dataset surfaces as a `MPS_PARSER_ERROR ... Error opening MPS file`
test failure at 0ms — it is not a build or logic failure.

Before running any C++ or Python tests, follow the dataset download and
`RAPIDS_DATASET_ROOT_DIR` export steps in the repo's `CONTRIBUTING.md`
("Building for development" section) — that is the canonical list and mapping.

If a test fails with a missing-file error, run the matching download step from
`CONTRIBUTING.md` and re-run the test. Do not report missing-dataset failures
back to the user as the task outcome.

## Python Bindings

cuOpt uses Cython to bridge Python and C++. See [references/python_bindings.md](references/python_bindings.md) for the full architecture, parameter flow walkthrough, key files, and Cython patterns.

## Contributing — Commits, PRs, Common Tasks

For pre-commit setup, DCO sign-off (`git commit -s`), the fork-based PR workflow, the draft-PR rule for agents, PR-description rules (keep it short — no "how it works" walkthroughs or file tables), script and CI/workflow authoring principles (extend existing files before adding new ones; no speculative flags, restated defaults, or silent fallbacks), and step-by-step common-task recipes (adding a solver parameter, dependency, server endpoint, or CUDA kernel), see [references/contributing.md](references/contributing.md).

## Coding Conventions

For C++ naming (`snake_case`, `d_`/`h_` prefixes, `_t` suffix), file extensions (`.hpp`/`.cpp`/`.cu`/`.cuh` and which compiler each uses), include order, Python style, error handling (`CUOPT_EXPECTS`, `RAFT_CUDA_TRY`), memory management (RMM patterns, no raw `new`/`delete`), and test-impact rules, see [references/conventions.md](references/conventions.md).

## Troubleshooting & CI

For build/test pitfalls (Cython rebuild, OOM, CUDA driver mismatch, missing `nvcc`) and CI failure diagnostics (style checks, DCO failures, dependency drift), see [references/troubleshooting.md](references/troubleshooting.md).

## Key Files Reference

| Purpose | Location |
|---------|----------|
| Main build script | `build.sh` |
| Dependencies | `dependencies.yaml` |
| C++ formatting | `.clang-format` |
| Conda environments | `conda/environments/` |
| Test data | `datasets/` |
| CI scripts | `ci/` |

## Canonical Documentation

- **Contributing/build/test**: [CONTRIBUTING.md](../../CONTRIBUTING.md)
- **CI scripts**: [ci/README.md](../../ci/README.md)
- **Release scripts**: [ci/release/README.md](../../ci/release/README.md)
- **Docs build**: [docs/cuopt/README.md](../../docs/cuopt/README.md)
- **Python binding architecture**: [references/python_bindings.md](references/python_bindings.md)

_Shell-execution, install, sudo, and outside-workspace policies are covered by [Refusal Rules — Read First](#refusal-rules--read-first) at the top of this skill._

## VRP dimension internals (routing engine)

When implementing or debugging **VRP dimensions** (constraints, objectives, forward/backward propagation, `combine`, local-search deltas), read:

- **`references/vrp_skills.md`** — architecture contracts, required interfaces, and implementation checklist.

Read it **before** adding a new dimension or changing combine semantics.

## Numerical issues in non-routing solver internals

When a bug surfaces as **wrong-but-plausible** solver output (invalid lower bound, unexpectedly large duals, 10× iteration blow-up after a small change) rather than a crash, read:

- **`resources/numerical_debugging.md`** — methodology for locating catastrophic-cancellation sites, the cancellation patterns endemic to cMIR / flow-cover / MIR-style cut construction, and threshold guidance for numerical guards.

Apply the *instrument-first, guard-at-the-exact-site* workflow it describes before patching — speculative fixes on these symptoms usually miss.
