/*
 * SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

#include <cuda_runtime.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <memory>

namespace {

constexpr int kRows = 1 << 20;
constexpr int kValue = 7;
constexpr int kTrials = 32;

void check_cuda(cudaError_t status, const char* what)
{
  if (status != cudaSuccess) {
    std::fprintf(stderr, "%s failed: %s\n", what, cudaGetErrorString(status));
    std::abort();
  }
}

__global__ void fill_kernel(int* data, int rows, int value)
{
  int idx = blockIdx.x * blockDim.x + threadIdx.x;
  if (idx >= rows) return;

  int adjusted = value;
  for (int spin = 0; spin < 4096; ++spin) {
    adjusted += (spin & 1);
    adjusted -= (spin & 1);
  }
  data[idx] = adjusted;
}

__global__ void checksum_kernel(const int* data, std::uint64_t* out, int rows)
{
  int idx = blockIdx.x * blockDim.x + threadIdx.x;
  if (idx < rows) {
    atomicAdd(reinterpret_cast<unsigned long long*>(out),
              static_cast<unsigned long long>(data[idx]));
  }
}

struct NativeGpuTable {
  int* data{};
  int rows{};
  cudaStream_t producer_stream{};

  explicit NativeGpuTable(int row_count) : rows(row_count)
  {
    check_cuda(cudaStreamCreateWithFlags(&producer_stream, cudaStreamNonBlocking),
               "create producer stream");
    check_cuda(cudaMalloc(&data, sizeof(int) * rows), "allocate table data");
  }

  ~NativeGpuTable()
  {
    if (data != nullptr) {
      cudaFree(data);
    }
    if (producer_stream != nullptr) {
      cudaStreamDestroy(producer_stream);
    }
  }
};

std::shared_ptr<NativeGpuTable> build_table_async(int value)
{
  auto table = std::make_shared<NativeGpuTable>(kRows);
  int block = 256;
  int grid = (table->rows + block - 1) / block;
  fill_kernel<<<grid, block, 0, table->producer_stream>>>(table->data, table->rows, value);
  check_cuda(cudaGetLastError(), "launch fill kernel");
  return table;
}

std::uint64_t consume_on_stream(const std::shared_ptr<NativeGpuTable>& table,
                                cudaStream_t consumer_stream)
{
  std::uint64_t* d_sum{};
  std::uint64_t h_sum{};
  int block = 256;
  int grid = (table->rows + block - 1) / block;

  check_cuda(cudaMalloc(&d_sum, sizeof(std::uint64_t)), "allocate checksum");
  check_cuda(cudaMemsetAsync(d_sum, 0, sizeof(std::uint64_t), consumer_stream),
             "clear checksum");

  checksum_kernel<<<grid, block, 0, consumer_stream>>>(table->data, d_sum, table->rows);
  check_cuda(cudaGetLastError(), "launch checksum kernel");
  check_cuda(cudaMemcpyAsync(&h_sum,
                             d_sum,
                             sizeof(std::uint64_t),
                             cudaMemcpyDeviceToHost,
                             consumer_stream),
             "copy checksum");
  check_cuda(cudaStreamSynchronize(consumer_stream), "sync consumer stream");
  check_cuda(cudaFree(d_sum), "free checksum");
  return h_sum;
}

}  // namespace

int main()
{
  cudaStream_t consumer_stream{};
  check_cuda(cudaStreamCreateWithFlags(&consumer_stream, cudaStreamNonBlocking),
             "create consumer stream");

  std::uint64_t expected = static_cast<std::uint64_t>(kRows) * kValue;
  int failures = 0;

  for (int trial = 0; trial < kTrials; ++trial) {
    auto table = build_table_async(kValue);
    std::uint64_t actual = consume_on_stream(table, consumer_stream);
    if (actual != expected) {
      std::fprintf(stderr,
                   "trial %d checksum mismatch: got %llu expected %llu\n",
                   trial,
                   static_cast<unsigned long long>(actual),
                   static_cast<unsigned long long>(expected));
      ++failures;
    }
  }

  check_cuda(cudaStreamDestroy(consumer_stream), "destroy consumer stream");
  if (failures != 0) {
    std::fprintf(stderr, "%d stale handoff checks observed\n", failures);
    return 1;
  }
  std::puts("all handoffs matched expected checksum");
  return 0;
}
