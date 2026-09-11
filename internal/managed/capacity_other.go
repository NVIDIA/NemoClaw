//go:build !linux

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package managed

import (
	"context"
	"errors"
)

func (*Docker) Capacity(context.Context, Spec, *Observation) error {
	return errors.New("Spark runtime is qualified only on local Linux ARM64 GB10")
}
