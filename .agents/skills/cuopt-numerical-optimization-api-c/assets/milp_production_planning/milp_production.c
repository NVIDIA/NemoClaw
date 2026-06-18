/*
 * SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Production planning MILP (C API): two products, resource limits, maximize profit.
 * Variables: Product_A (x1), Product_B (x2), both integer, lb 10 and 15.
 * Constraints: 2*x1+x2 <= 100 (machine), x1+3*x2 <= 120 (labor), 4*x1+2*x2 <= 200 (material).
 * Objective: maximize 50*x1 + 30*x2  => minimize -50*x1 - 30*x2.
 */
#include <cuopt/linear_programming/cuopt_c.h>
#include <cuopt/linear_programming/constants.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    cuOptOptimizationProblem problem = NULL;
    cuOptSolverSettings settings = NULL;
    cuOptSolution solution = NULL;

    const cuopt_int_t num_variables = 2;
    const cuopt_int_t num_constraints = 3;

    /* CSR: row0 2*x1+1*x2, row1 1*x1+3*x2, row2 4*x1+2*x2 */
    cuopt_int_t row_offsets[] = {0, 2, 4, 6};
    cuopt_int_t column_indices[] = {0, 1, 0, 1, 0, 1};
    cuopt_float_t values[] = {2.0, 1.0, 1.0, 3.0, 4.0, 2.0};

    cuopt_float_t objective_coefficients[] = {-50.0, -30.0};
    cuopt_float_t constraint_upper[] = {100.0, 120.0, 200.0};
    cuopt_float_t constraint_lower[] = {-CUOPT_INFINITY, -CUOPT_INFINITY, -CUOPT_INFINITY};
    cuopt_float_t var_lower[] = {10.0, 15.0};
    cuopt_float_t var_upper[] = {CUOPT_INFINITY, CUOPT_INFINITY};
    char variable_types[] = {CUOPT_INTEGER, CUOPT_INTEGER};

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
    status = cuOptSetFloatParameter(settings, CUOPT_TIME_LIMIT, 30.0);
    if (status != CUOPT_SUCCESS) {
        printf("Error setting time limit: %d\n", status);
        goto cleanup;
    }
    status = cuOptSetFloatParameter(settings, CUOPT_MIP_RELATIVE_GAP, 0.01);
    if (status != CUOPT_SUCCESS) {
        printf("Error setting MIP relative gap: %d\n", status);
        goto cleanup;
    }

    status = cuOptSolve(problem, settings, &solution);
    if (status != CUOPT_SUCCESS) {
        printf("Error solving: %d\n", status);
        goto cleanup;
    }

    cuopt_float_t objective_value;
    status = cuOptGetObjectiveValue(solution, &objective_value);
    if (status != CUOPT_SUCCESS) {
        printf("Error getting objective value: %d\n", status);
        goto cleanup;
    }
    /* We minimized -profit, so total profit = -objective_value */
    printf("Total profit: %f\n", -objective_value);

    cuopt_float_t *sol = malloc((size_t)num_variables * sizeof(cuopt_float_t));
    if (sol) {
        status = cuOptGetPrimalSolution(solution, sol);
        if (status != CUOPT_SUCCESS) {
            printf("Error getting primal solution: %d\n", status);
            free(sol);
            goto cleanup;
        }
        printf("Product_A: %f, Product_B: %f\n", sol[0], sol[1]);
        free(sol);
    }

cleanup:
    cuOptDestroyProblem(&problem);
    cuOptDestroySolverSettings(&settings);
    cuOptDestroySolution(&solution);
    return (status == CUOPT_SUCCESS) ? 0 : 1;
}
