# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""Example 1: cumsum / cumprod with blocking

Optimized implementation using static persistent scheduling.

Key techniques
  1. Static persistent scheduling over batch tiles
  2. occupancy=4 (scan is memory-bound)
  3. Larger BATCH_SIZE_BLOCK (64)
  4. TMA loads
"""

import math

import cuda.tile as ct
import torch


@ct.kernel(occupancy=4)
def kernel_cumsum(
    input,
    output,
    num_tiles: ct.Constant[int],
    BATCH_SIZE_BLOCK: ct.Constant[int],
    INPUT_SIZE: ct.Constant[int],
):
    """Compute cumulative sum along axis 1 for each batch tile."""
    pid = ct.bid(0)
    num_programs = ct.num_blocks(0)

    for bid in range(pid, num_tiles, num_programs):
        tx = ct.load(input, index=(bid, 0), shape=(BATCH_SIZE_BLOCK, INPUT_SIZE))
        tz = ct.cumsum(tx, axis=1)
        ct.store(output, index=(bid, 0), tile=tz)


def test_cumsum(input, output, batch_size, input_size, batch_size_block):
    """Launch the cumulative sum kernel and return the output."""
    num_tiles = math.ceil(batch_size / batch_size_block)

    NUM_SM = torch.cuda.get_device_properties("cuda").multi_processor_count
    num_programs = min(NUM_SM * 4, num_tiles)
    grid = (num_programs,)

    ct.launch(
        torch.cuda.current_stream(), grid, kernel_cumsum, (input, output, num_tiles, batch_size_block, input_size)
    )
    return output


def torch_reference(input):
    """Compute cumulative sum along dim 1 using PyTorch."""
    return torch.cumsum(input, dim=1)


if __name__ == "__main__":
    torch.manual_seed(42)
    batch_size = 128  # non-reduction dimension
    input_size = 256  # reduction dimension (axis=1)
    batch_size_block = 64
    input = torch.rand(batch_size, input_size, dtype=torch.float16, device="cuda")
    output = torch.zeros_like(input, device="cuda")
    output = test_cumsum(input, output, batch_size, input_size, batch_size_block)
    ref = torch_reference(input)

    if torch.allclose(output, ref, atol=1e-2, rtol=1e-2):
        print("Test passed!")
    else:
        print("Test failed!")
