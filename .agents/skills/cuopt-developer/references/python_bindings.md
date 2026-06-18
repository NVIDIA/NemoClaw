# Python Bindings Guide

How Python bindings work in cuOpt and how to extend them.

## Architecture: Three Layers

```text
Python API Layer (.py)        ← User-facing, docstrings, convenience methods
        ↓
Cython Wrapper Layer (.pyx)   ← Memory management, GIL handling, type conversion
        ↓
C++ Implementation (.hpp/.cu) ← Solver logic, CUDA kernels
```

## Key Directories

| Layer | Path | Purpose |
|-------|------|---------|
| Library loader | `python/libcuopt/libcuopt/load.py` | Dynamically loads `libcuopt.so` via ctypes |
| Python API | `python/cuopt/cuopt/linear_programming/` | User-facing classes (`Problem`, `SolverSettings`) |
| Python API | `python/cuopt/cuopt/routing/` | Routing API |
| Cython bindings | `python/cuopt/cuopt/linear_programming/solver/solver_wrapper.pyx` | Solver bridge |
| Cython bindings | `python/cuopt/cuopt/linear_programming/data_model/data_model_wrapper.pyx` | Data model bridge |
| Cython declarations | `python/cuopt/cuopt/linear_programming/solver/solver.pxd` | C++ interface declarations |
| Cython declarations | `python/cuopt/cuopt/linear_programming/data_model/data_model.pxd` | C++ interface declarations |
| C++ headers | `cpp/include/cuopt/linear_programming/` | Public API |
| C++ implementation | `cpp/src/` | Solver internals |

## File Types

| Extension | Purpose | Example |
|-----------|---------|---------|
| `.pxd` | Cython declaration — declares C++ classes, functions, enums for Cython | `solver.pxd` |
| `.pyx` | Cython implementation — wraps C++ in Python-callable code | `solver_wrapper.pyx` |
| `.py` | Pure Python — user-facing API, no direct C++ calls | `solver.py`, `data_model.py` |

## How a Parameter Flows: End-to-End Example

Tracing `optimality_tolerance` from Python to C++:

### Step 1: User Python code

```python
settings = SolverSettings()
settings.set_optimality_tolerance(1e-2)
solution = linear_programming.Solve(data_model, settings)
```

### Step 2: Python API stores the setting

`python/cuopt/cuopt/linear_programming/solver_settings/solver_settings.py`:

```python
def set_optimality_tolerance(self, eps_optimal):
    for param in solver_params:
        if param.endswith("tolerance"):
            self.settings_dict[param] = eps_optimal
```

Parameters are discovered at import time from C++ via reflection (see step 3).

### Step 3: Cython discovers parameter names from C++

`python/cuopt/cuopt/linear_programming/solver/solver_parameters.pyx`:

```cython
cpdef get_solver_parameter_names():
    cdef unique_ptr[solver_settings_t[int, double]] unique_solver_settings
    unique_solver_settings.reset(new solver_settings_t[int, double]())
    cdef vector[string] parameter_names = unique_solver_settings.get().get_parameter_names()

    cdef list py_parameter_names = []
    for i in range(parameter_names.size()):
        py_parameter_names.append(parameter_names[i].decode("utf-8"))
    return py_parameter_names

solver_params = get_solver_parameter_names()  # Called at import time
```

### Step 4: Cython passes settings to C++

`python/cuopt/cuopt/linear_programming/solver/solver_wrapper.pyx`:

```cython
cdef set_solver_setting(
        unique_ptr[solver_settings_t[int, double]]& unique_solver_settings,
        settings, ...):
    cdef solver_settings_t[int, double]* c_solver_settings = unique_solver_settings.get()
    for name, value in settings.settings_dict.items():
        c_solver_settings.set_parameter_from_string(
            name.encode('utf-8'),
            str(value).encode('utf-8')
        )
```

### Step 5: Cython calls C++ solver with GIL released

```cython
def Solve(py_data_model_obj, settings, mip=False):
    # ... setup ...
    with nogil:  # Release Python GIL for GPU computation
        sol_ret_ptr = move(call_solve(
            data_model_obj.c_data_model_view.get(),
            unique_solver_settings.get(),
        ))
    return create_solution(move(sol_ret_ptr), data_model_obj)
```

Always release the GIL around C++ calls that do GPU work — this allows other Python threads to run during solve.

### Step 6: C++ implementation receives the call

`cpp/src/math_optimization/solver_settings.cu`:

```cpp
void solver_settings_t<i_t, f_t>::set_parameter_from_string(
    const std::string& name, const std::string& value)
{
    // Routes to appropriate setter
    pdlp_settings_.set_optimality_tolerance(std::stof(value));
}
```

## Key Cython Patterns

### Declaring C++ classes in .pxd

```cython
cdef extern from "cuopt/linear_programming/solver_settings.hpp" namespace "cuopt::linear_programming":
    ctypedef enum pdlp_solver_mode_t "cuopt::linear_programming::pdlp_solver_mode_t":
        Stable1 "cuopt::linear_programming::pdlp_solver_mode_t::Stable1"
        Stable2 "cuopt::linear_programming::pdlp_solver_mode_t::Stable2"

    cdef cppclass solver_settings_t[i_t, f_t]:
        solver_settings_t() except +
        vector[string] get_parameter_names()
        void set_parameter_from_string(const string& name, const string& value) except +
```

### C++ object lifecycle with unique_ptr

```cython
from libcpp.memory cimport unique_ptr, move

cdef unique_ptr[solver_settings_t[int, double]] settings
settings.reset(new solver_settings_t[int, double]())
# Auto-destroyed when scope exits
```

### Bridging C++ enums to Python IntEnum

```python
class PDLPSolverMode(IntEnum):
    Stable1 = pdlp_solver_mode_t.Stable1
    Stable2 = pdlp_solver_mode_t.Stable2
```

### Type conversions

| Direction | Pattern |
|-----------|---------|
| Python `str` → C++ `string` | `name.encode('utf-8')` |
| C++ `string` → Python `str` | `cstring.decode('utf-8')` |
| C++ `vector<double>` → numpy | `np.asarray(<double[:size]> vec.data()).copy()` |
| numpy → C++ pointer | Pass `.data` pointer via Cython typed memoryview |

### Device memory handling

```cython
from rmm.pylibrmm.device_buffer import DeviceBuffer

if result_ptr.is_gpu():
    solution_buf = DeviceBuffer.c_from_unique_ptr(
        move(get_gpu_solution(result_ptr[0]))
    )
    solution = series_from_buf(solution_buf, pa.float64()).to_numpy()
```

## Build System

Cython modules are built via CMake + rapids-cython-core.

### CMakeLists.txt pattern

`python/cuopt/cuopt/linear_programming/solver/CMakeLists.txt`:

```cmake
set(cython_sources solver_wrapper.pyx solver_parameters.pyx)
set(linked_libraries cuopt::cuopt)
rapids_cython_create_modules(...)
```

### Build command

```bash
./build.sh cuopt    # Builds Cython extensions + Python package
```

After modifying `.pyx` or `.pxd` files, you must rebuild: Cython changes are **not** reflected until recompiled.

## Adding a New Parameter: Checklist

1. **C++ header** — Add parameter to settings struct in `cpp/include/cuopt/`
2. **C++ implementation** — Add setter/getter and wire into `set_parameter_from_string()` in `cpp/src/`
3. **Cython declaration (.pxd)** — If the parameter requires a new C++ method signature, declare it
4. **Cython wrapper (.pyx)** — If using the string-based parameter interface (`set_parameter_from_string`), no `.pyx` change is needed — the parameter is auto-discovered via reflection
5. **Python API (.py)** — Add a convenience method in `SolverSettings` if warranted
6. **Server schema** — Update `docs/cuopt/source/cuopt_spec.yaml` if the parameter should be server-accessible
7. **Tests** — Add tests at both C++ (`cpp/tests/`) and Python (`python/cuopt/cuopt/tests/`) levels
8. **Rebuild** — `./build.sh libcuopt && ./build.sh cuopt`

## Lazy Loading Pattern

`python/cuopt/cuopt/__init__.py` uses lazy imports for CPU-only environments:

```python
_submodules = ["linear_programming", "routing", "distance_engine"]

def __getattr__(name):
    if name in _submodules:
        import importlib
        return importlib.import_module(f"cuopt.{name}")
    raise AttributeError(...)
```

This allows importing `cuopt` on hosts without a GPU (e.g., for remote solve via server).
