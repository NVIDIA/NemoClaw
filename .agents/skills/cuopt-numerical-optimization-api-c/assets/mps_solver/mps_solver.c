/*
 * SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Solve LP/MILP from MPS file (C API).
 * Usage: mps_solver <path_to.mps>
 */
#include <cuopt/linear_programming/cuopt_c.h>
#include <cuopt/linear_programming/constants.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <mps_file>\n", argv[0]);
        return 1;
    }
    const char *filename = argv[1];

    cuOptOptimizationProblem problem = NULL;
    cuOptSolverSettings settings = NULL;
    cuOptSolution solution = NULL;
    cuopt_int_t num_variables = 0;
    cuopt_float_t *primal = NULL;

    cuopt_int_t status = cuOptReadProblem(filename, &problem);
    if (status != CUOPT_SUCCESS) {
        printf("Error reading MPS file: %d\n", status);
        return 1;
    }

    status = cuOptGetNumVariables(problem, &num_variables);
    if (status != CUOPT_SUCCESS) {
        printf("Error getting number of variables: %d\n", status);
        goto cleanup;
    }
    printf("Variables: %d\n", num_variables);

    status = cuOptCreateSolverSettings(&settings);
    if (status != CUOPT_SUCCESS) {
        printf("Error creating solver settings: %d\n", status);
        goto cleanup;
    }
    status = cuOptSetFloatParameter(settings, CUOPT_TIME_LIMIT, 60.0);
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

    cuopt_float_t objective_value, time;
    cuopt_int_t termination_status;
    status = cuOptGetObjectiveValue(solution, &objective_value);
    if (status != CUOPT_SUCCESS) {
        printf("Error getting objective value: %d\n", status);
        goto cleanup;
    }
    status = cuOptGetSolveTime(solution, &time);
    if (status != CUOPT_SUCCESS) {
        printf("Error getting solve time: %d\n", status);
        goto cleanup;
    }
    status = cuOptGetTerminationStatus(solution, &termination_status);
    if (status != CUOPT_SUCCESS) {
        printf("Error getting termination status: %d\n", status);
        goto cleanup;
    }

    printf("Termination status: %d\n", termination_status);
    printf("Solve time: %f s\n", time);
    printf("Objective: %f\n", objective_value);

    primal = malloc((size_t)num_variables * sizeof(cuopt_float_t));
    if (primal) {
        status = cuOptGetPrimalSolution(solution, primal);
        if (status != CUOPT_SUCCESS) {
            printf("Error getting primal solution: %d\n", status);
            free(primal);
            primal = NULL;
            goto cleanup;
        }
        printf("Primal (first 10): ");
        for (cuopt_int_t i = 0; i < (num_variables < 10 ? num_variables : 10); i++)
            printf("%f ", primal[i]);
        if (num_variables > 10) printf("... (%d total)", (int)num_variables);
        printf("\n");
        free(primal);
    }

cleanup:
    cuOptDestroyProblem(&problem);
    cuOptDestroySolverSettings(&settings);
    cuOptDestroySolution(&solution);
    return (status == CUOPT_SUCCESS) ? 0 : 1;
}
