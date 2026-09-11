// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package spark

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/NVIDIA/NemoClaw/internal/snapshot"
)

const PreparedBytes int64 = 28 * GiB // Capacity ceiling for this pinned table.

type Preparation struct {
	Key   string                  `json:"key"`
	Files []snapshot.VerifiedFile `json:"files"`
}

func PreparationKey() string {
	h := sha256.Sum256([]byte(ModelManifest().Key() + RecipeRevision + PreparerSHA256 + VerifierSHA256()))
	return hex.EncodeToString(h[:])
}

func ObservePreparation(dir string) (Preparation, error) {
	var p Preparation
	b, err := os.ReadFile(filepath.Join(dir, "complete.json"))
	if err != nil {
		return p, err
	}
	if json.Unmarshal(b, &p) != nil || p.Key != PreparationKey() || len(p.Files) != 2 {
		return p, errors.New("packed PLE completion record conflicts with pinned preparation")
	}
	for i, f := range p.Files {
		name := PreparedFile
		if i == 1 {
			name += ".json"
		}
		s, err := os.Lstat(filepath.Join(dir, name))
		if err != nil {
			return p, fmt.Errorf("packed PLE observation failed: %w", err)
		}
		if f.Name != name || f.Size <= 0 || len(f.SHA256) != 64 || !s.Mode().IsRegular() || s.Size() != f.Size || s.ModTime().UnixNano() != f.Modified {
			return p, errors.New("verified packed PLE data changed")
		}
	}
	return p, nil
}

// Prepare publishes a whole verified directory, never a half-written receipt.
// The fixed runner executes only the packaged preparer and verifier. An
// interrupted staging directory is resumable; established artifacts are retained.
func Prepare(ctx context.Context, root, modelDir string, run func(context.Context, bool, string, string) ([]byte, error)) (Preparation, error) {
	dir := filepath.Join(root, PreparationKey())
	if p, err := ObservePreparation(dir); err == nil {
		return p, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return p, err
	}
	if _, err := os.Lstat(dir); !errors.Is(err, os.ErrNotExist) {
		return Preparation{}, errors.New("established preparation directory lacks complete evidence; retained for inspection")
	}
	staging := dir + ".preparing"
	if err := os.MkdirAll(staging, 0700); err != nil {
		return Preparation{}, err
	}
	// The upstream tool skips a complete-length binary even if a crash prevented
	// metadata publication. Only this unpublished staging output may be rebuilt.
	if _, err := os.Stat(filepath.Join(staging, PreparedFile+".json")); errors.Is(err, os.ErrNotExist) {
		if err = os.Remove(filepath.Join(staging, PreparedFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return Preparation{}, err
		}
	} else if err != nil {
		return Preparation{}, err
	}
	if _, err := run(ctx, false, modelDir, staging); err != nil {
		return Preparation{}, fmt.Errorf("packed PLE preparation interrupted; staged data retained: %w", err)
	}
	b, err := run(ctx, true, modelDir, staging)
	if err != nil {
		return Preparation{}, fmt.Errorf("packed PLE verification failed; staged data retained: %w", err)
	}
	var file snapshot.File
	if json.Unmarshal(b, &file) != nil || file.Name != PreparedFile || file.Size <= 0 || file.Size > PreparedBytes || len(file.SHA256) != 64 {
		return Preparation{}, errors.New("packed PLE verifier returned incomplete evidence")
	}
	p := Preparation{Key: PreparationKey()}
	for _, f := range []snapshot.File{file, {Name: PreparedFile + ".json"}} {
		path := filepath.Join(staging, f.Name)
		if f.Size == 0 {
			data, err := os.ReadFile(path)
			if err != nil {
				return p, err
			}
			h := sha256.Sum256(data)
			f.Size = int64(len(data))
			f.SHA256 = hex.EncodeToString(h[:])
		}
		fd, err := os.Open(path)
		if err != nil {
			return p, err
		}
		s, err := fd.Stat()
		if err == nil {
			err = fd.Sync()
		}
		fd.Close()
		if err != nil {
			return p, err
		}
		if !s.Mode().IsRegular() || s.Size() != f.Size {
			return p, errors.New("prepared file changed during verification")
		}
		p.Files = append(p.Files, snapshot.VerifiedFile{File: f, Modified: s.ModTime().UnixNano()})
	}
	if err := snapshot.WriteJSON(filepath.Join(staging, "complete.json"), p); err != nil {
		return p, err
	}
	if err := os.Rename(staging, dir); err != nil {
		return p, err
	}
	parent, err := os.Open(root)
	if err != nil {
		return p, err
	}
	defer parent.Close()
	if err = parent.Sync(); err != nil {
		return p, err
	}
	return ObservePreparation(dir)
}
