// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"github.com/NVIDIA/NemoClaw/internal/provider"
	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"os"
)

func main() {
	if err := providerserver.Serve(context.Background(), provider.New, providerserver.ServeOpts{Address: provider.Address}); err != nil {
		os.Exit(1)
	}
}
