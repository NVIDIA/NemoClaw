//go:build integration

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"os/exec"
	"runtime"
	"testing"
)

func TestFabricOpenClawNativeMessaging(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "arm64" {
		t.Skip("the Fabric OpenClaw image requires native Linux ARM64")
	}
	cmd := exec.CommandContext(t.Context(), "python3", "tools/openclaw-native-test.py")
	cmd.Dir = "../.."
	output, err := cmd.CombinedOutput()
	t.Logf("native messaging fixture output:\n%s", output)
	if err != nil {
		t.Fatalf("native messaging test failed: %v; requires Docker, OpenSSL, and the image from python3 image/fabric/build.py --harness openclaw", err)
	}
}
