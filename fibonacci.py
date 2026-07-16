# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate a Fibonacci sequence."""


def fibonacci(count: int) -> list[int]:
    """Return the first ``count`` numbers in the Fibonacci sequence."""
    if count < 0:
        raise ValueError("count must be non-negative")

    sequence: list[int] = []
    first, second = 0, 1

    for _ in range(count):
        sequence.append(first)
        first, second = second, first + second

    return sequence


if __name__ == "__main__":
    print(fibonacci(10))
