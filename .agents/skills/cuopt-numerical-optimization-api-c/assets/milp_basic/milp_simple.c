/*
 * SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Simple MILP (C API): same as LP but x1 is integer
 */
#include <cuopt/linear_programming/cuopt_c.h>
#include <cuopt/linear_programming/constants.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    cuOptOptimizationProblem problem = NULL;
    cuOptSolverSettings settings = NULL;
    cuOptSolution solution = NULL;

    cuopt_int_t num_variables = 2;
    cuopt_int_t num_constraints = 2;

    cuopt_int_t row_offsets[] = {0, 2, 4};
    cuopt_int_t column_indices[] = {0, 1, 0, 1};
    cuopt_float_t values[] = {3.0, 4.0, 2.7, 10.1};

    cuopt_float_t objective_coefficients[] = {-0.2, 0.1};
    cuopt_float_t constraint_upper[] = {5.4, 4.9};
    cuopt_float_t constraint_lower[] = {-CUOPT_INFINITY, -CUOPT_INFINITY};
    cuopt_float_t var_lower[] = {0.0, 0.0};
    cuopt_float_t var_upper[] = {CUOPT_INFINITY, CUOPT_INFINITY};

    /* x1 = INTEGER, x2 = CONTINUOUS */
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

    status = cuOptCreateSolverSettings(&settings);
    if (status != CUOPT_SUCCESS) {
        printf("Error creating solver settings: %d\n", status);
        goto cleanup;
    }
    status = cuOptSetFloatParameter(settings, CUOPT_MIP_ABSOLUTE_TOLERANCE, 0.0001);
    if (status != CUOPT_SUCCESS) {
        printf("Error setting MIP absolute tolerance: %d\n", status);
        goto cleanup;
    }
    status = cuOptSetFloatParameter(settings, CUOPT_MIP_RELATIVE_GAP, 0.01);
    if (status != CUOPT_SUCCESS) {
        printf("Error setting MIP relative gap: %d\n", status);
        goto cleanup;
    }
    status = cuOptSetFloatParameter(settings, CUOPT_TIME_LIMIT, 120.0);
    if (status != CUOPT_SUCCESS) {
        printf("Error setting time limit: %d\n", status);
        goto cleanup;
    }

    status = cuOptSolve(problem, settings, &solution);
    if (status != CUOPT_SUCCESS) {
        printf("Error solving: %d\n", status);
        goto cleanup;
    }

    if (solution != NULL) {
        cuopt_float_t objective_value;
        status = cuOptGetObjectiveValue(solution, &objective_value);
        if (status != CUOPT_SUCCESS) {
            printf("Error getting objective value: %d\n", status);
            goto cleanup;
        }
        printf("Objective: %f\n", objective_value);

        cuopt_float_t *sol = malloc((size_t)num_variables * sizeof(cuopt_float_t));
        if (sol) {
            status = cuOptGetPrimalSolution(solution, sol);
            if (status != CUOPT_SUCCESS) {
                printf("Error getting primal solution: %d\n", status);
                free(sol);
                goto cleanup;
            }
            printf("x1 (integer) = %f, x2 (continuous) = %f\n", sol[0], sol[1]);
            free(sol);
        }
    }

cleanup:
    cuOptDestroyProblem(&problem);
    cuOptDestroySolverSettings(&settings);
    cuOptDestroySolution(&solution);
    return (status == CUOPT_SUCCESS) ? 0 : 1;
}
