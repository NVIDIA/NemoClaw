// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"crypto/sha256"
	"os"
	"os/exec"
	"runtime"
	"testing"
)

func TestFabricOpenClawNativeMessaging(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "arm64" {
		t.Skip("the Fabric OpenClaw image requires native Linux ARM64")
	}
	// Record fixture/source inputs and make their changes invalidate Go's test cache.
	for _, name := range []string{
		"tools/openclaw-native-test.py", "test/openclaw_native_messaging.py",
		"test/openclaw_cli_driver.mjs", "test/openclaw_fixture_transport.mjs",
		"image/fabric/openclaw_adapter.py",
		"image/fabric/fabric.py", "image/fabric/build.py", "image/fabric/openclaw-dependencies.lock",
	} {
		data, err := os.ReadFile("../../" + name)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("%s sha256=%x", name, sha256.Sum256(data))
	}
	cmd := exec.CommandContext(t.Context(), "python3", "tools/openclaw-native-test.py")
	cmd.Dir = "../.."
	output, err := cmd.CombinedOutput()
	t.Logf("native messaging fixture output:\n%s", output)
	if err != nil {
		t.Fatalf("native messaging test failed: %v; requires Docker, OpenSSL, and the image from python3 image/fabric/build.py --harness openclaw", err)
	}
}
