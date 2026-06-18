# First-Time Dev Environment Setup

Read this when a contributor is setting up the cuOpt dev environment for the first time — clone, conda env, initial build, initial test run. Once that's working, the rest of `cuopt-developer` (build/test commands, conventions, contribution workflow) takes over.

## Required questions

Ask these before issuing commands:

1. **OS and GPU** — Linux? Which CUDA version does the GPU driver support (run `nvidia-smi`, top-right "CUDA Version")?
2. **Goal** — Contributing upstream, or local fork/modification?
3. **Component** — C++/CUDA core, Python bindings, server, docs, or CI?

The component answer scopes which part of the codebase to read first and which build target to use (e.g. `./build.sh libcuopt` vs `./build.sh cuopt`).

## Setup walk-through (conceptual)

1. **Clone** the cuOpt repo (and submodules, if any).
2. **Pre-flight checks** — CUDA driver compatibility, conda env selection and activation, `PARALLEL_LEVEL`, dataset setup. Walk through these before the first build using SKILL.md → [Pre-flight Checks](../SKILL.md#pre-flight-checks-required-before-first-build-or-test). Skipping any of them surfaces as confusing build- or runtime errors later.
3. **First build** — once the env is active, run `./build.sh` (or a component-scoped variant). Targets and `PARALLEL_LEVEL` tuning live in [build_and_test.md](build_and_test.md).
4. **First test run** — fetch datasets per `CONTRIBUTING.md` first, then run the C++/Python test suites from [build_and_test.md](build_and_test.md). A passing build + test confirms the env is wired up correctly.
5. **Optional** — `pre-commit install` to run style checks on every `git commit` (see [contributing.md](contributing.md)).

Use the repo's `README` and `CONTRIBUTING.md` as the canonical source for exact versions and any deviations.

## After setup

Once `./build.sh` and the test suites succeed, the env is verified. From here, ongoing build/test/debug/contribute work is covered by the rest of `cuopt-developer`:

- Build/test commands and `PARALLEL_LEVEL` — [build_and_test.md](build_and_test.md)
- Pre-commit, DCO sign-off, fork PR workflow — [contributing.md](contributing.md)
- C++/Python/CUDA naming, memory, testing conventions — [conventions.md](conventions.md)
- Build/CI failure diagnosis — [troubleshooting.md](troubleshooting.md)
