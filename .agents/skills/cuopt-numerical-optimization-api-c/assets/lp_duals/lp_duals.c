/*
 * SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * LP with dual values and reduced costs (C API).
 * Problem: Minimize 3x + 2y + 5z subject to x + y + z = 4, 2x + y + z = 5, x,y,z >= 0.
 */
#include <cuopt/linear_programming/cuopt_c.h>
#include <cuopt/linear_programming/constants.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    cuOptOptimizationProblem problem = NULL;
    cuOptSolverSettings settings = NULL;
    cuOptSolution solution = NULL;

    const cuopt_int_t num_variables = 3;
    const cuopt_int_t num_constraints = 2;

    /* Constraint matrix CSR: row0 1*x+1*y+1*z, row1 2*x+1*y+1*z */
    cuopt_int_t row_offsets[] = {0, 3, 6};
    cuopt_int_t column_indices[] = {0, 1, 2, 0, 1, 2};
    cuopt_float_t values[] = {1.0, 1.0, 1.0, 2.0, 1.0, 1.0};

    cuopt_float_t objective_coefficients[] = {3.0, 2.0, 5.0};
    cuopt_float_t constraint_lower[] = {4.0, 5.0};
    cuopt_float_t constraint_upper[] = {4.0, 5.0};
    cuopt_float_t var_lower[] = {0.0, 0.0, 0.0};
    cuopt_float_t var_upper[] = {CUOPT_INFINITY, CUOPT_INFINITY, CUOPT_INFINITY};
    char variable_types[] = {CUOPT_CONTINUOUS, CUOPT_CONTINUOUS, CUOPT_CONTINUOUS};

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
    status = cuOptSetFloatParameter(settings, CUOPT_ABSOLUTE_PRIMAL_TOLERANCE, 0.0001);
    if (status != CUOPT_SUCCESS) {
        printf("Error setting primal tolerance: %d\n", status);
        goto cleanup;
    }
    status = cuOptSetFloatParameter(settings, CUOPT_TIME_LIMIT, 60.0);
    if (status != CUOPT_SUCCESS) {
        printf("Error setting time limit: %d\n", status);
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
    printf("Objective: %f\n", objective_value);

    cuopt_float_t *primal = malloc((size_t)num_variables * sizeof(cuopt_float_t));
    if (primal) {
        status = cuOptGetPrimalSolution(solution, primal);
        if (status != CUOPT_SUCCESS) {
            printf("Error getting primal solution: %d\n", status);
            free(primal);
            goto cleanup;
        }
        printf("x = %f, y = %f, z = %f\n", primal[0], primal[1], primal[2]);
        free(primal);
    }

    cuopt_float_t *dual = malloc((size_t)num_constraints * sizeof(cuopt_float_t));
    if (dual) {
        status = cuOptGetDualSolution(solution, dual);
        if (status == CUOPT_SUCCESS) {
            printf("Constraint c1 DualValue = %f\n", dual[0]);
            printf("Constraint c2 DualValue = %f\n", dual[1]);
        }
        free(dual);
    }

    cuopt_float_t *reduced = malloc((size_t)num_variables * sizeof(cuopt_float_t));
    if (reduced) {
        status = cuOptGetReducedCosts(solution, reduced);
        if (status == CUOPT_SUCCESS) {
            printf("x ReducedCost = %f, y ReducedCost = %f, z ReducedCost = %f\n",
                   reduced[0], reduced[1], reduced[2]);
        }
        free(reduced);
    }

cleanup:
    cuOptDestroyProblem(&problem);
    cuOptDestroySolverSettings(&settings);
    cuOptDestroySolution(&solution);
    return (status == CUOPT_SUCCESS) ? 0 : 1;
}
