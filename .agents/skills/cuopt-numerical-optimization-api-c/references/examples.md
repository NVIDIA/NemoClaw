# LP/MILP: C API Examples

## Required Headers

```c
#include <cuopt/linear_programming/cuopt_c.h>   // Core API
#include <cuopt/linear_programming/constants.h> // Parameter name macros (CUOPT_TIME_LIMIT, etc.)
```

## Parameter Setting Functions

**Important:** Use the correct function for each parameter type:

| Function | Use For | Example |
|----------|---------|---------|
| `cuOptSetFloatParameter` | Float params (tolerances, time_limit) | `cuOptSetFloatParameter(settings, CUOPT_TIME_LIMIT, 60.0)` |
| `cuOptSetIntegerParameter` | Integer params (log_to_console, method) | `cuOptSetIntegerParameter(settings, CUOPT_LOG_TO_CONSOLE, 1)` |
| `cuOptSetParameter` | String params | `cuOptSetParameter(settings, "custom_param", "value")` |

**Common mistake:** Using non-existent function names like `cuOptSetIntParameter` (correct: `cuOptSetIntegerParameter`).

---

## Simple LP

```c
/*
 * Solve: minimize  -0.2*x1 + 0.1*x2
 *        subject to  3.0*x1 + 4.0*x2 <= 5.4
 *                    2.7*x1 + 10.1*x2 <= 4.9
 *                    x1, x2 >= 0
 */
#include <cuopt/linear_programming/cuopt_c.h>
#include <cuopt/linear_programming/constants.h>
#include <stdio.h>
#include <stdlib.h>

int main() {
    cuOptOptimizationProblem problem = NULL;
    cuOptSolverSettings settings = NULL;
    cuOptSolution solution = NULL;

    cuopt_int_t num_variables = 2;
    cuopt_int_t num_constraints = 2;

    // Constraint matrix in CSR format
    cuopt_int_t row_offsets[] = {0, 2, 4};
    cuopt_int_t column_indices[] = {0, 1, 0, 1};
    cuopt_float_t values[] = {
        3.0,
        4.0,
        2.7,
        10.1
    };

    // Objective coefficients
    cuopt_float_t objective_coefficients[] = {
        -0.2,
        0.1
    };

    // Constraint bounds (lower <= Ax <= upper)
    cuopt_float_t constraint_upper_bounds[] = {
        5.4,
        4.9
    };
    cuopt_float_t constraint_lower_bounds[] = {-CUOPT_INFINITY, -CUOPT_INFINITY};

    // Variable bounds
    cuopt_float_t var_lower_bounds[] = {
        0.0,
        0.0
    };
    cuopt_float_t var_upper_bounds[] = {CUOPT_INFINITY, CUOPT_INFINITY};

    // Variable types
    char variable_types[] = {CUOPT_CONTINUOUS, CUOPT_CONTINUOUS};

    cuopt_int_t status;

    // Create problem
    status = cuOptCreateRangedProblem(
        num_constraints, num_variables, CUOPT_MINIMIZE,
        0.0,  // objective offset
        objective_coefficients,
        row_offsets, column_indices, values,
        constraint_lower_bounds, constraint_upper_bounds,
        var_lower_bounds, var_upper_bounds,
        variable_types,
        &problem
    );
    if (status != CUOPT_SUCCESS) {
        printf("Error creating problem: %d\n", status);
        return 1;
    }

    // Create and configure solver settings
    cuOptCreateSolverSettings(&settings);
    cuOptSetFloatParameter(settings, CUOPT_ABSOLUTE_PRIMAL_TOLERANCE, 0.0001);
    cuOptSetFloatParameter(settings, CUOPT_TIME_LIMIT, 60.0);

    // Solve
    status = cuOptSolve(problem, settings, &solution);
    if (status != CUOPT_SUCCESS) {
        printf("Error solving: %d\n", status);
        goto cleanup;
    }

    // Get results
    cuopt_float_t time, objective_value;
    cuopt_int_t termination_status;

    cuOptGetSolveTime(solution, &time);
    cuOptGetTerminationStatus(solution, &termination_status);
    cuOptGetObjectiveValue(solution, &objective_value);

    printf("Status: %d\n", termination_status);
    printf("Time: %f s\n", time);
    printf("Objective: %f\n", objective_value);

    // Get solution values
    cuopt_float_t* sol = malloc(num_variables * sizeof(cuopt_float_t));
    cuOptGetPrimalSolution(solution, sol);
    printf("x1 = %f\n", sol[0]);
    printf("x2 = %f\n", sol[1]);
    free(sol);

cleanup:
    cuOptDestroyProblem(&problem);
    cuOptDestroySolverSettings(&settings);
    cuOptDestroySolution(&solution);
    return (status == CUOPT_SUCCESS) ? 0 : 1;
}
```

## MILP (with integer variables)

```c
/*
 * Same as LP but x1 is integer
 */
#include <cuopt/linear_programming/cuopt_c.h>
#include <cuopt/linear_programming/constants.h>
#include <stdio.h>
#include <stdlib.h>

int main() {
    cuOptOptimizationProblem problem = NULL;
    cuOptSolverSettings settings = NULL;
    cuOptSolution solution = NULL;

    cuopt_int_t num_variables = 2;
    cuopt_int_t num_constraints = 2;

    cuopt_int_t row_offsets[] = {0, 2, 4};
    cuopt_int_t column_indices[] = {0, 1, 0, 1};
    cuopt_float_t values[] = {
        3.0,
        4.0,
        2.7,
        10.1
    };

    cuopt_float_t objective_coefficients[] = {
        -0.2,
        0.1
    };
    cuopt_float_t constraint_upper[] = {
        5.4,
        4.9
    };
    cuopt_float_t constraint_lower[] = {-CUOPT_INFINITY, -CUOPT_INFINITY};
    cuopt_float_t var_lower[] = {
        0.0,
        0.0
    };
    cuopt_float_t var_upper[] = {CUOPT_INFINITY, CUOPT_INFINITY};

    // x1 = INTEGER, x2 = CONTINUOUS
    char variable_types[] = {CUOPT_INTEGER, CUOPT_CONTINUOUS};

    cuopt_int_t status = cuOptCreateRangedProblem(
        num_constraints, num_variables, CUOPT_MINIMIZE, 0.0,
        objective_coefficients,
        row_offsets, column_indices, values,
        constraint_lower, constraint_upper,
        var_lower, var_upper,
        variable_types, &problem
    );
    if (status != CUOPT_SUCCESS) {
        printf("Error creating problem: %d\n", status);
        return 1;
    }

    cuOptCreateSolverSettings(&settings);
    cuOptSetFloatParameter(settings, CUOPT_MIP_ABSOLUTE_TOLERANCE, 0.0001);
    cuOptSetFloatParameter(settings, CUOPT_MIP_RELATIVE_GAP, 0.01);
    cuOptSetFloatParameter(settings, CUOPT_TIME_LIMIT, 120.0);

    status = cuOptSolve(problem, settings, &solution);
    if (status != CUOPT_SUCCESS) {
        printf("Error solving: %d\n", status);
        goto cleanup;
    }

    if (solution != NULL) {
        cuopt_float_t objective_value;
        cuOptGetObjectiveValue(solution, &objective_value);
        printf("Objective: %f\n", objective_value);

        cuopt_float_t* sol = malloc(num_variables * sizeof(cuopt_float_t));
        if (sol == NULL) {
            printf("Error: memory allocation failed\n");
            status = -1;
            goto cleanup;
        }
        cuOptGetPrimalSolution(solution, sol);
        printf("x1 (integer) = %f\n", sol[0]);
        printf("x2 (continuous) = %f\n", sol[1]);
        free(sol);
    }

cleanup:
    cuOptDestroyProblem(&problem);
    cuOptDestroySolverSettings(&settings);
    cuOptDestroySolution(&solution);
    return (status == CUOPT_SUCCESS) ? 0 : 1;
}
```

## Build & Run

See [`assets/README.md`](../assets/README.md) for the canonical conda-env
include/library/`LD_LIBRARY_PATH` setup, plus a `gcc` build command. The
same recipe applies here — substitute `lp_example.c` for the file name.

## Constants Reference

```c
// Optimization sense
CUOPT_MINIMIZE
CUOPT_MAXIMIZE

// Variable types
CUOPT_CONTINUOUS
CUOPT_INTEGER

// Special values
CUOPT_INFINITY      // Use for unbounded
-CUOPT_INFINITY     // Use for no lower bound

// Return codes
CUOPT_SUCCESS       // 0
```

## Parameter Name Constants (from constants.h)

```c
// Float parameters (use with cuOptSetFloatParameter)
CUOPT_TIME_LIMIT                    // "time_limit"
CUOPT_ABSOLUTE_PRIMAL_TOLERANCE     // "absolute_primal_tolerance"
CUOPT_ABSOLUTE_DUAL_TOLERANCE       // "absolute_dual_tolerance"
CUOPT_RELATIVE_PRIMAL_TOLERANCE     // "relative_primal_tolerance"
CUOPT_RELATIVE_DUAL_TOLERANCE       // "relative_dual_tolerance"
CUOPT_MIP_ABSOLUTE_GAP              // "mip_absolute_gap"
CUOPT_MIP_RELATIVE_GAP              // "mip_relative_gap"
CUOPT_MIP_ABSOLUTE_TOLERANCE        // "mip_absolute_tolerance"
CUOPT_MIP_RELATIVE_TOLERANCE        // "mip_relative_tolerance"
CUOPT_MIP_INTEGRALITY_TOLERANCE     // "mip_integrality_tolerance"

// Integer parameters (use with cuOptSetIntegerParameter)
CUOPT_LOG_TO_CONSOLE                // "log_to_console"
CUOPT_ITERATION_LIMIT               // "iteration_limit"
CUOPT_METHOD                        // "method" (see CUOPT_METHOD_* values)
CUOPT_PDLP_SOLVER_MODE              // "pdlp_solver_mode" (see CUOPT_PDLP_SOLVER_MODE_* values)
CUOPT_PRESOLVE                      // "presolve"
CUOPT_NUM_CPU_THREADS               // "num_cpu_threads"
CUOPT_NUM_GPUS                      // "num_gpus"

// Method values (for CUOPT_METHOD)
CUOPT_METHOD_CONCURRENT             // 0 - Run multiple methods concurrently
CUOPT_METHOD_PDLP                   // 1 - PDLP solver
CUOPT_METHOD_DUAL_SIMPLEX           // 2 - Dual simplex
CUOPT_METHOD_BARRIER                // 3 - Barrier method

// PDLP solver mode values (for CUOPT_PDLP_SOLVER_MODE)
CUOPT_PDLP_SOLVER_MODE_STABLE1      // 0
CUOPT_PDLP_SOLVER_MODE_STABLE2      // 1
CUOPT_PDLP_SOLVER_MODE_METHODICAL1  // 2
CUOPT_PDLP_SOLVER_MODE_FAST1        // 3
CUOPT_PDLP_SOLVER_MODE_STABLE3      // 4
```

> **Complete list:** See `cpp/include/cuopt/linear_programming/constants.h` for all 50+ parameter constants including termination status codes, constraint senses, and file format constants.

---

## Additional References (tested in CI)

For more complete C examples with full error handling, see:

| Resource | Location |
|----------|----------|
| **Constants Header** | `cpp/include/cuopt/linear_programming/constants.h` |
| C API Header | `cpp/include/cuopt/linear_programming/cuopt_c.h` |
| C API Documentation | `docs/cuopt/source/cuopt-c/lp-qp-milp/lp-qp-milp-c-api.rst` |
| Simple LP Example | `docs/cuopt/source/cuopt-c/lp-qp-milp/examples/simple_lp_example.c` |
| Simple MILP Example | `docs/cuopt/source/cuopt-c/lp-qp-milp/examples/simple_milp_example.c` |
| MPS File Example | `docs/cuopt/source/cuopt-c/lp-qp-milp/examples/mps_file_example.c` |

The `constants.h` header contains all parameter name macros, termination status codes, method values, and constraint sense constants.
