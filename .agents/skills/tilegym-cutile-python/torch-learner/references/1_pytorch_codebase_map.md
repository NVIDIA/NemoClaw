# PyTorch Codebase Map

This document describes the general architecture and layout of the PyTorch source tree. Use this as a guide for navigating the cloned PyTorch repository.

**IMPORTANT:** All paths in this document are relative to the PyTorch source checkout in the skill cache. The default path is `~/.cache/tilegym/pytorch-source`, unless the user chooses another cache directory. For example, `torch/nn/modules/` means `torch/nn/modules/` in that checkout. ALL searches must be scoped to that checkout — never search outside it.

**IMPORTANT:** File paths and directory structures can change between PyTorch versions. Always verify paths by searching the actual cloned source rather than assuming fixed locations. The search strategies below are more reliable than memorized paths.

## Top-Level Layout

The PyTorch repo has a stable high-level structure:

| Directory | Purpose |
|-----------|---------|
| `torch/` | Python-level API — your entry point for tracing |
| `aten/` | ATen: the C++ tensor library with native op implementations |
| `c10/` | Core abstractions (Tensor, Storage, DispatchKey) |
| `tools/` | Code generation scripts and autograd definitions |
| `torchgen/` | Codegen infrastructure |
| `functorch/` | Functional transforms (vmap, grad) |
| `test/` | Python test suite |

## Layer 1: Python API (`torch/`)

### Finding nn.Module Classes

All `nn.Module` subclasses live under `torch/nn/modules/`. To find a specific module:

```bash
# Find where a module class is defined
grep -rn "class LSTM\b" torch/nn/modules/
grep -rn "class Conv2d\b" torch/nn/modules/
grep -rn "class LayerNorm\b" torch/nn/modules/
```

General patterns:
- `torch/nn/modules/` contains one file per module category
- `torch/nn/functional.py` contains the `F.*` functional API
- `torch/nn/init.py` contains weight initialization functions

### Finding Functional API Functions

```bash
# Find a function in the functional API
grep -n "def cross_entropy" torch/nn/functional.py
grep -n "def linear" torch/nn/functional.py
grep -n "def relu" torch/nn/functional.py
```

### Finding torch Namespace Functions

Some `torch.*` functions have Python wrappers:

```bash
# Check torch/functional.py for Python-level wrappers
grep -n "def einsum" torch/functional.py
grep -n "def stft" torch/functional.py

# Check torch/__init__.py for namespace imports
grep -n "einsum\|matmul\|cat" torch/__init__.py
```

### Key Bridge Files

These files connect Python to C++. Search for them in the repo:

```bash
# Variable functions bridge (routes _VF.* to C++)
find torch/ -name "_VF.py"

# Python reference implementations of ATen ops
find torch/ -name "_refs" -type d

# Decomposition registrations
find torch/ -name "decompositions.py" -path "*_decomp*"
```

The bridge mechanisms are:
- `_VF.<name>()` → routes through `torch._C._VariableFunctions`
- `torch._C._nn.<name>()` → direct C++ binding
- `torch.ops.aten.<name>()` → direct operator call
- `torch._C` namespace → auto-generated bindings

## Layer 2: Code Generation (`tools/` and `torchgen/`)

PyTorch generates much of its dispatch and binding code from YAML declarations.

### Critical YAML Files

These two YAML files are the most important in the entire repo:

```bash
# The master registry of ALL ATen operations — find it:
find aten/ -name "native_functions.yaml"
# Typically at: aten/src/ATen/native/native_functions.yaml

# Autograd backward formulas — find it:
find tools/ -name "derivatives.yaml"
# Typically at: tools/autograd/derivatives.yaml
```

**`native_functions.yaml`** declares every native operation with:
- Function signature (name, parameters, return type)
- Dispatch keys (CPU, CUDA, etc.)
- Backend-specific implementation function names

**`derivatives.yaml`** maps forward operations to their gradient computations.

### Code Generators

```bash
# Find the main code generator
find torchgen/ -name "gen.py"

# Find autograd generators
find tools/autograd/ -name "gen_*.py"

# Find C++ templates used for code generation
find tools/autograd/ -name "templates" -type d
```

### Generated Code

Generated files only exist after building PyTorch (in the `build/` directory). To understand the generation without building:
1. Read the YAML entry for your op
2. Read the template files in `tools/autograd/templates/`
3. Read the generator scripts to understand the transformation

## Layer 3: ATen C++ Library (`aten/`)

ATen ("A Tensor Library") contains all C++ implementations.

### Finding C++ Op Implementations

The primary strategy is to search `native_functions.yaml` for the op name, then follow the dispatch table to find the implementation files:

```bash
# Step 1: Find the op in native_functions.yaml
grep -A 10 "func:.*lstm\b" aten/src/ATen/native/native_functions.yaml

# Step 2: The dispatch: section tells you the function names
# e.g., dispatch: { CPU: lstm_cpu, CUDA: lstm_cuda }

# Step 3: Search for those function names in the C++ source
grep -rn "lstm_cpu\|lstm_cuda" aten/src/ATen/native/
```

### Searching for C++ Implementations

```bash
# Search all .cpp files under native/
grep -rn "function_name" aten/src/ATen/native/ --include="*.cpp"

# Search CUDA kernels (.cu files)
grep -rn "function_name" aten/src/ATen/native/ --include="*.cu"

# Search cuDNN wrappers
grep -rn "function_name" aten/src/ATen/native/ --include="*.cpp" | grep -i cudnn

# Search for dispatch stub registrations
grep -rn "REGISTER_DISPATCH.*my_op" aten/src/ATen/native/
```

### General C++ Directory Layout

The `aten/src/ATen/native/` directory organizes code by:
- **Root-level `.cpp` files**: device-generic or CPU-default implementations
- **`cuda/` subdirectory**: CUDA kernel implementations (`.cu` files)
- **`cudnn/` subdirectory**: cuDNN library wrappers
- **`cpu/` subdirectory**: vectorized CPU kernels
- **`sparse/`, `quantized/`, `nested/` subdirectories**: specialized tensor type implementations

To discover the actual layout for your PyTorch version:

```bash
# List all .cpp files at the native/ root level
ls aten/src/ATen/native/*.cpp

# List CUDA kernel files
ls aten/src/ATen/native/cuda/*.cu 2>/dev/null
ls aten/src/ATen/native/cuda/*.cpp 2>/dev/null

# List cuDNN wrapper files
ls aten/src/ATen/native/cudnn/*.cpp 2>/dev/null
```

### Core ATen Abstractions

```bash
# Find Tensor definition
grep -rn "class Tensor\b" aten/src/ATen/core/ --include="*.h"

# Find dispatcher
grep -rn "class Dispatcher\b" aten/src/ATen/ --include="*.h" 2>/dev/null || \
grep -rn "class Dispatcher\b" c10/ --include="*.h"

# Find DispatchKey enum
grep -rn "enum class DispatchKey" c10/ --include="*.h"
```

## Search Strategies

### Strategy: Find an Op End-to-End

Given an operation name (e.g., `relu`, `lstm`, `conv2d`):

```bash
PYTORCH_SRC="${TILEGYM_SKILL_CACHE_DIR:-$HOME/.cache/tilegym}/pytorch-source"
OP_NAME=lstm

# 1. Python module (nn.Module)
grep -rn "class.*${OP_NAME}" ${PYTORCH_SRC}/torch/nn/modules/ -i

# 2. Python functional
grep -n "def.*${OP_NAME}" ${PYTORCH_SRC}/torch/nn/functional.py -i

# 3. native_functions.yaml entry
grep -A 15 "func:.*${OP_NAME}" ${PYTORCH_SRC}/aten/src/ATen/native/native_functions.yaml

# 4. C++ implementation (follow function names from YAML dispatch table)
grep -rn "${OP_NAME}" ${PYTORCH_SRC}/aten/src/ATen/native/ --include="*.cpp" --include="*.cu" --include="*.h" -l

# 5. Autograd backward
grep -A 10 "name:.*${OP_NAME}" ${PYTORCH_SRC}/tools/autograd/derivatives.yaml
```

### Strategy: Find cuDNN/cuBLAS Usage

```bash
# Find cuDNN calls for an op
grep -rn "cudnn.*${OP_NAME}\|${OP_NAME}.*cudnn" ${PYTORCH_SRC}/aten/src/ATen/native/ -i -l

# Find cuBLAS usage
grep -rn "cublas\|blas::gemm\|blas::gemv" ${PYTORCH_SRC}/aten/src/ATen/native/ -l

# Find CUDA kernel launches
grep -rn "<<<.*>>>" ${PYTORCH_SRC}/aten/src/ATen/native/ --include="*.cu" -l
```

### Strategy: Find How a Python Call Reaches C++

```bash
# Check what the Python function calls
grep -A 20 "def ${OP_NAME}" ${PYTORCH_SRC}/torch/nn/functional.py

# Look for _VF bridge usage
grep -rn "_VF\.${OP_NAME}" ${PYTORCH_SRC}/torch/

# Look for torch._C calls
grep -rn "torch\._C.*${OP_NAME}" ${PYTORCH_SRC}/torch/

# Look for torch.ops calls
grep -rn "torch\.ops.*${OP_NAME}" ${PYTORCH_SRC}/torch/
```

### Strategy: Find Decompositions

```bash
# Check if an op has decompositions (for torch.compile)
grep -rn "${OP_NAME}" ${PYTORCH_SRC}/torch/_decomp/decompositions.py

# Check Python reference implementations
grep -rn "${OP_NAME}" ${PYTORCH_SRC}/torch/_refs/ -l 2>/dev/null
```

## Quick Lookup Workflow

Given a PyTorch operation, trace it through layers in this order:

1. **Python module**: Search `torch/nn/modules/` for the module class → read `forward()`
2. **Python functional**: Search `torch/nn/functional.py` for the function
3. **Bridge**: Identify whether it uses `_VF`, `torch._C`, or `torch.ops`
4. **YAML**: Search `native_functions.yaml` for the op name
5. **C++ implementation**: Follow the `dispatch:` table, search for function names in `aten/src/ATen/native/`
6. **CUDA kernel**: Search `aten/src/ATen/native/cuda/` and `cudnn/` directories
7. **Autograd**: Search `derivatives.yaml` for backward formulas
