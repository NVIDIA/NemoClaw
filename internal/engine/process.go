// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/NVIDIA/NemoClaw/internal/subprocess"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

type Manifest struct {
	Version, Go, OpenTofu, Osquery string
	Files                          map[string]string
}

func VerifyBundle(dir string) error {
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return errors.New("bundle manifest missing; run go run ./tools/bundle")
	}
	var m Manifest
	if json.Unmarshal(b, &m) != nil || m.OpenTofu != "1.12.6" || m.Osquery != "5.23.1" {
		return errors.New("incompatible bundle manifest")
	}
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	for _, p := range []string{"bin/nemoclaw" + ext, "libexec/tofu" + ext, "libexec/osqueryi" + ext, "libexec/nemoclaw-osquery.ext" + ext, "providers/registry.opentofu.org/nvidia/nemoclaw/" + m.Version + "/" + runtime.GOOS + "_" + runtime.GOARCH + "/terraform-provider-nemoclaw_v" + m.Version + ext} {
		if m.Files[p] == "" {
			return errors.New("bundle is incomplete")
		}
	}
	for p, digest := range m.Files {
		if !filepath.IsLocal(p) {
			return errors.New("invalid bundle path")
		}
		f, err := os.Open(filepath.Join(dir, p))
		if err != nil {
			return errors.New("bundle file missing")
		}
		h := sha256.New()
		_, err = io.Copy(h, f)
		f.Close()
		if err != nil || hex.EncodeToString(h.Sum(nil)) != digest {
			return fmt.Errorf("bundle integrity check failed for %s", p)
		}
	}
	return nil
}
func (e *Engine) tofu(ctx context.Context, args ...string) ([]byte, error) {
	env := append(subprocess.CleanEnv(), "NEMOCLAW_INTERNAL_BUNDLE="+e.BundleDir, "TF_IN_AUTOMATION=1", "TF_INPUT=0", "TF_CLI_CONFIG_FILE="+filepath.Join(e.StateDir, "providers.tfrc"), "CHECKPOINT_DISABLE=1")
	return subprocess.Run(ctx, e.StateDir, subprocess.Executable(e.BundleDir, "tofu"), env, args...)
}
