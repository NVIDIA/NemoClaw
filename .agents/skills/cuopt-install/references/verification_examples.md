# Installation: Verification Examples

## Verify Python Installation

```python
# Basic import test
import cuopt
print(f"cuOpt version: {cuopt.__version__}")

# GPU access test
from cuopt import routing

dm = routing.DataModel(n_locations=3, n_fleet=1, n_orders=2)
print("DataModel created - GPU access OK")

# Quick solve test
import cudf
cost_matrix = cudf.DataFrame([[0,1,2],[1,0,1],[2,1,0]], dtype="float32")
dm.add_cost_matrix(cost_matrix)
dm.set_order_locations(cudf.Series([1, 2], dtype="int32"))

solution = routing.Solve(dm, routing.SolverSettings())
print(f"Solve status: {solution.get_status()}")
print("cuOpt installation verified!")
```

## Verify LP/MILP

```python
from cuopt.linear_programming.problem import Problem, CONTINUOUS, MAXIMIZE
from cuopt.linear_programming.solver_settings import SolverSettings

problem = Problem("Test")
x = problem.addVariable(lb=0, vtype=CONTINUOUS, name="x")
problem.setObjective(x, sense=MAXIMIZE)
problem.addConstraint(x <= 10)

problem.solve(SolverSettings())
print(f"Status: {problem.Status.name}")
print(f"x = {x.getValue()}")
print("LP/MILP working!")
```

## Verify Server Installation

```bash
# Start server in background
python -m cuopt_server.cuopt_service --ip 0.0.0.0 --port 8000 &
SERVER_PID=$!

# Wait for startup
sleep 5

# Health check
curl -s http://localhost:8000/cuopt/health | jq .

# Quick routing test
curl -s -X POST "http://localhost:8000/cuopt/request" \
  -H "Content-Type: application/json" \
  -H "CLIENT-VERSION: custom" \
  -d '{
    "cost_matrix_data": {"data": {"0": [[0,1],[1,0]]}},
    "travel_time_matrix_data": {"data": {"0": [[0,1],[1,0]]}},
    "task_data": {"task_locations": [1]},
    "fleet_data": {"vehicle_locations": [[0,0]], "capacities": [[10]]},
    "solver_config": {"time_limit": 1}
  }' | jq .

# Stop server
kill $SERVER_PID
```

## Verify C API Installation

```bash
# Find header
echo "Looking for cuopt_c.h..."
find ${CONDA_PREFIX:-/usr} -name "cuopt_c.h" 2>/dev/null

# Find library
echo "Looking for libcuopt.so..."
find ${CONDA_PREFIX:-/usr} -name "libcuopt.so" 2>/dev/null

# Test compile (if gcc available)
cat > /tmp/test_cuopt.c << 'EOF'
#include <cuopt/linear_programming/cuopt_c.h>
#include <stdio.h>
int main() {
    printf("cuopt_c.h found and compilable\n");
    return 0;
}
EOF

gcc -I${CONDA_PREFIX}/include -c /tmp/test_cuopt.c -o /tmp/test_cuopt.o && \
  echo "C API headers OK" || echo "C API headers not found"
```

## Check System Requirements

```bash
# GPU check
nvidia-smi

# CUDA version
nvcc --version

# Compute capability (need >= 7.0)
nvidia-smi --query-gpu=compute_cap --format=csv,noheader

# Python version
python --version

# Available memory
nvidia-smi --query-gpu=memory.total,memory.free --format=csv
```

## Check Package Versions

```python
import importlib.metadata

packages = ["cuopt-cu12", "cuopt-cu13", "cuopt-server-cu12", "cuopt-server-cu13", "cuopt-sh-client"]
for pkg in packages:
    try:
        version = importlib.metadata.version(pkg)
        print(f"{pkg}: {version}")
    except importlib.metadata.PackageNotFoundError:
        pass
```

## Troubleshooting Commands

```bash
# Check if cuopt is installed
pip list | grep -i cuopt

# Check conda packages
conda list | grep -i cuopt

# Check CUDA runtime
python -c "import torch; print(torch.cuda.is_available())" 2>/dev/null || echo "PyTorch not installed"

# Check cudf (routing dependency)
python -c "import cudf; print(f'cudf: {cudf.__version__}')"

# Check rmm (memory manager)
python -c "import rmm; print(f'rmm: {rmm.__version__}')"
```

## Docker Verification

```bash
# Pull and run
docker run --gpus all --rm nvidia/cuopt:latest-cuda12.9-py3.13 python -c "
import cuopt
print(f'cuOpt version: {cuopt.__version__}')
from cuopt import routing
dm = routing.DataModel(n_locations=3, n_fleet=1, n_orders=2)
print('GPU access OK')
"
```

---

## Additional References

| Topic | Resource |
|-------|----------|
| Installation Guide | [NVIDIA cuOpt Docs](https://docs.nvidia.com/cuopt/user-guide/latest/installation.html) |
| System Requirements | [cuOpt Requirements](https://docs.nvidia.com/cuopt/user-guide/latest/requirements.html) |
| Docker Images | See `ci/docker/` in this repo |
| Conda Recipes | See `conda/recipes/` in this repo |
