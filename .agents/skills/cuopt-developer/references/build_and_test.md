# Build & Test

Read this for component-level build commands, run-test commands, and `PARALLEL_LEVEL` detail. **Pre-flight checks** (CUDA driver compatibility, conda env activation, dataset setup) live in [SKILL.md → Build & Test → Pre-flight Checks](../SKILL.md#pre-flight-checks-required-before-first-build-or-test) — always run those first.

## PARALLEL_LEVEL

`PARALLEL_LEVEL` controls the number of parallel compile jobs. It defaults to `$(nproc)` (all cores), which can cause OOM on machines with limited RAM — CUDA compilation needs roughly 4–8 GB per job. Set it based on available RAM:

```bash
export PARALLEL_LEVEL=8   # adjust based on available RAM
```

## Build Everything

```bash
./build.sh
```

## Build Specific Components

```bash
./build.sh --help                                       # Lists build options
./build.sh libcuopt                                     # C++ library
./build.sh libcuopt --skip-routing-build --skip-tests-build --skip-c-python-adapters --cache-tool=ccache  # native LP/MIP-focused build without routing/tests/adapters
./build.sh cuopt                                        # Python package
./build.sh cuopt_server                                 # Server
./build.sh docs                                         # Documentation
```

## Run Tests

> Activate the conda env used to build first (`conda activate <env-name>`) and ensure datasets are fetched — see [Pre-flight Checks](../SKILL.md#pre-flight-checks-required-before-first-build-or-test) in SKILL.md.

```bash
# C++ tests
ctest --test-dir cpp/build

# Python tests
pytest -v python/cuopt/cuopt/tests

# Server tests
pytest -v python/cuopt_server/tests
```
