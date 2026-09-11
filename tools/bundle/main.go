// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type Artifact struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}
type Pins struct {
	Go, OpenTofu string
	Platforms    map[string]map[string]Artifact
}
type Manifest struct {
	Version, Go, OpenTofu string
	Files                 map[string]string
}

func main() {
	if err := build(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func build() error {
	platform := flag.String("platform", runtime.GOOS+"_"+runtime.GOARCH, "target OS_arch")
	flag.Parse()
	b, err := os.ReadFile("versions.json")
	if err != nil {
		return err
	}
	var pins Pins
	if err = json.Unmarshal(b, &pins); err != nil {
		return err
	}
	if runtime.Version() != "go"+pins.Go {
		return fmt.Errorf("build with Go %s", pins.Go)
	}
	artifacts, ok := pins.Platforms[*platform]
	if !ok {
		return errors.New("unsupported bundle platform")
	}
	goos, goarch, _ := strings.Cut(*platform, "_")
	root := filepath.Join("dist", *platform)
	// libexec is generated output. Drop retired helpers before recording the bundle.
	if err = os.RemoveAll(filepath.Join(root, "libexec")); err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Join(root, "libexec"), 0755); err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Join(root, "bin"), 0755); err != nil {
		return err
	}
	ext := ""
	if goos == "windows" {
		ext = ".exe"
	}
	version, err := sourceVersion()
	if err != nil {
		return err
	}
	manifest := Manifest{Version: version, Go: pins.Go, OpenTofu: pins.OpenTofu, Files: map[string]string{}}
	archive, err := download(artifacts["tofu"])
	if err != nil {
		return err
	}
	if err = extractBinary(archive, filepath.Join(root, "libexec", "tofu"+ext)); err != nil {
		return err
	}
	providerDir := filepath.Join(root, "providers", "registry.opentofu.org", "nvidia", "nemoclaw", version, *platform)
	// dist is generated output. Keep one provider version in each bundle.
	if err = os.RemoveAll(filepath.Join(root, "providers")); err != nil {
		return err
	}
	if err = os.MkdirAll(providerDir, 0755); err != nil {
		return err
	}
	for _, target := range []struct{ Package, Output string }{
		{"./cmd/nemoclaw", filepath.Join(root, "bin", "nemoclaw"+ext)},
		{"./cmd/terraform-provider-nemoclaw", filepath.Join(providerDir, "terraform-provider-nemoclaw_v"+version+ext)},
	} {
		goBinary := filepath.Join(runtime.GOROOT(), "bin", "go")
		if runtime.GOOS == "windows" {
			goBinary += ".exe"
		}
		cmd := exec.Command(goBinary, "build", "-trimpath", "-buildvcs=false", "-ldflags", "-X github.com/NVIDIA/NemoClaw/internal/provider.Version="+version, "-o", target.Output, target.Package)
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+goos, "GOARCH="+goarch)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err = cmd.Run(); err != nil {
			return err
		}
	}
	err = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || d.Name() == "manifest.json" {
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		h := sha256.New()
		if _, err = io.Copy(h, f); err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		manifest.Files[filepath.ToSlash(rel)] = hex.EncodeToString(h.Sum(nil))
		return nil
	})
	if err != nil {
		return err
	}
	b, err = json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(root, "manifest.json"), append(b, '\n'), 0644); err != nil {
		return err
	}
	fmt.Println(root)
	return nil
}

func sourceVersion() (string, error) {
	h := sha256.New()
	err := filepath.WalkDir(".", func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != "." && (strings.HasPrefix(d.Name(), ".") || d.Name() == "dist") {
				return filepath.SkipDir
			}
			return nil
		}
		// These files are embedded in the provider and runtime observation code.
		// Changing either must select a fresh provider version in the local mirror.
		if !strings.HasSuffix(p, ".go") && p != "go.mod" && p != "go.sum" && p != "internal/spark/model.json" && p != "internal/spark/verify_packed.py" {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		fmt.Fprintln(h, p)
		h.Write(b)
		return nil
	})
	if err != nil {
		return "", err
	}
	return "0.1.0-dev.g" + hex.EncodeToString(h.Sum(nil))[:12], nil
}

func download(a Artifact) (string, error) {
	cache := filepath.Join(".tools", "cache")
	if err := os.MkdirAll(cache, 0700); err != nil {
		return "", err
	}
	dest := filepath.Join(cache, a.SHA256)
	if validDigest(dest, a.SHA256) {
		return dest, nil
	}
	// Reuse verified bootstrap downloads when present.
	if p := filepath.Join(".tools", "downloads", "tofu", path.Base(a.URL)); validDigest(p, a.SHA256) {
		return p, nil
	}
	client := http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(a.URL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("artifact download returned HTTP %d", resp.StatusCode)
	}
	f, err := os.CreateTemp(cache, "download-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	_, err = io.Copy(f, io.LimitReader(resp.Body, 2<<30))
	closeErr := f.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if !validDigest(f.Name(), a.SHA256) {
		return "", errors.New("artifact checksum mismatch")
	}
	if err = os.Rename(f.Name(), dest); err != nil {
		return "", err
	}
	return dest, nil
}
func validDigest(p, digest string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return false
	}
	return hex.EncodeToString(h.Sum(nil)) == digest
}
func extractBinary(archive, dest string) error {
	z, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer z.Close()
	for _, f := range z.File {
		if base := path.Base(f.Name); (base == "tofu" || base == "tofu.exe") && f.Mode().IsRegular() {
			r, err := f.Open()
			if err != nil {
				return err
			}
			defer r.Close()
			out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
			if err != nil {
				return err
			}
			_, err = io.Copy(out, r)
			return errors.Join(err, out.Close())
		}
	}
	return errors.New("archive contains no expected executable")
}
