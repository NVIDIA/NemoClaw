// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package snapshot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

type File struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type Manifest struct {
	Repository string `json:"repository"`
	Revision   string `json:"revision"`
	Files      []File `json:"files"`
}

type VerifiedFile struct {
	File
	Modified int64 `json:"modified"`
}

type Receipt struct {
	Manifest string         `json:"manifest"`
	Files    []VerifiedFile `json:"files"`
}

type Client struct {
	BaseURL string
	HTTP    *http.Client
}

func NewClient() Client {
	return Client{BaseURL: "https://huggingface.co", HTTP: &http.Client{
		Transport: &http.Transport{Proxy: nil, ResponseHeaderTimeout: time.Minute, IdleConnTimeout: 30 * time.Second},
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if len(via) >= 10 || r.URL.Scheme != "https" {
				return errors.New("model download redirect rejected")
			}
			return nil
		},
	}}
}

var revision = regexp.MustCompile(`^[a-f0-9]{40}$`)
var repository = regexp.MustCompile(`^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`)

func (m Manifest) Validate() error {
	if !revision.MatchString(m.Revision) || !repository.MatchString(m.Repository) || len(m.Files) == 0 {
		return errors.New("model manifest lacks immutable identity")
	}
	seen := map[string]bool{}
	for _, f := range m.Files {
		digest, err := hex.DecodeString(f.SHA256)
		if !filepath.IsLocal(f.Name) || filepath.ToSlash(filepath.Clean(f.Name)) != f.Name || strings.ContainsAny(f.Name, "\\\x00") || strings.HasPrefix(f.Name, ".nemoclaw") || f.Size <= 0 || err != nil || len(digest) != 32 || seen[f.Name] {
			return errors.New("model manifest has invalid or duplicate files")
		}
		seen[f.Name] = true
	}
	return nil
}

func (m Manifest) Key() string {
	b, _ := json.Marshal(m)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func (m Manifest) Bytes() int64 {
	var size int64
	for _, f := range m.Files {
		size += f.Size
	}
	return size
}

// Observe checks a previously verified immutable snapshot without downloading or
// changing receipts. Changed files require full verification during explicit apply.
func Observe(dir string, m Manifest) (Receipt, error) {
	var r Receipt
	if err := m.Validate(); err != nil {
		return r, err
	}
	b, err := os.ReadFile(filepath.Join(dir, ".nemoclaw-complete.json"))
	if err != nil {
		return r, err
	}
	if json.Unmarshal(b, &r) != nil || r.Manifest != m.Key() || len(r.Files) != len(m.Files) {
		return r, errors.New("snapshot completion record conflicts with pinned manifest")
	}
	for i, f := range m.Files {
		v := r.Files[i]
		if v.File != f || !unchanged(filepath.Join(dir, f.Name), v) {
			return r, errors.New("verified model snapshot changed or is incomplete")
		}
	}
	return r, nil
}

func unchanged(path string, v VerifiedFile) bool {
	s, err := os.Lstat(path)
	return err == nil && s.Mode().IsRegular() && s.Size() == v.Size && s.ModTime().UnixNano() == v.Modified
}

// Ensure resumes only this pinned snapshot. A single owned runtime is its writer.
// Failed requests retain partial bytes; another explicit apply resumes with Range.
func (c Client) Ensure(ctx context.Context, dir string, m Manifest, progress func(string)) (Receipt, error) {
	var result Receipt
	if err := m.Validate(); err != nil {
		return result, err
	}
	if r, err := Observe(dir, m); err == nil {
		return r, nil
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return result, err
	}
	result.Manifest = m.Key()
	for _, f := range m.Files {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if progress != nil {
			progress(f.Name)
		}
		v, err := c.ensureFile(ctx, dir, m, f)
		if err != nil {
			return result, fmt.Errorf("snapshot %s: %w", f.Name, err)
		}
		result.Files = append(result.Files, v)
	}
	if err := WriteJSON(filepath.Join(dir, ".nemoclaw-complete.json"), result); err != nil {
		return result, err
	}
	return result, nil
}

func (c Client) ensureFile(ctx context.Context, dir string, m Manifest, want File) (VerifiedFile, error) {
	path := filepath.Join(dir, want.Name)
	marker := path + ".nemoclaw-verified.json"
	var v VerifiedFile
	if b, err := os.ReadFile(marker); err == nil && json.Unmarshal(b, &v) == nil && v.File == want && unchanged(path, v) {
		return v, nil
	}
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() {
			return v, errors.New("snapshot path is not a regular file")
		}
		if err = verify(ctx, path, want); err != nil {
			return v, err
		}
		return record(path, marker, want)
	} else if !errors.Is(err, os.ErrNotExist) {
		return v, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return v, err
	}
	partial := path + ".nemoclaw-partial"
	if info, err := os.Lstat(partial); err == nil && !info.Mode().IsRegular() {
		return v, errors.New("partial snapshot is not a regular file")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return v, err
	}
	f, err := os.OpenFile(partial, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return v, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return v, err
	}
	offset := info.Size()
	if offset > want.Size {
		return v, errors.New("partial snapshot exceeds pinned size")
	}
	if offset < want.Size {
		u := c.BaseURL + "/" + m.Repository + "/resolve/" + m.Revision + "/" + url.PathEscape(want.Name)
		q, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return v, err
		}
		if offset > 0 {
			q.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
		}
		r, err := c.HTTP.Do(q)
		if err != nil {
			return v, errors.New("model transport failed; partial download retained")
		}
		defer r.Body.Close()
		if offset == 0 && r.StatusCode != http.StatusOK {
			return v, errors.New("model request rejected")
		}
		if offset > 0 && (r.StatusCode != http.StatusPartialContent || r.Header.Get("Content-Range") != fmt.Sprintf("bytes %d-%d/%d", offset, want.Size-1, want.Size)) {
			return v, errors.New("model server did not confirm the requested byte range")
		}
		if _, err = f.Seek(offset, io.SeekStart); err != nil {
			return v, err
		}
		n, err := io.Copy(f, io.LimitReader(r.Body, want.Size-offset+1))
		if err != nil || n != want.Size-offset {
			return v, errors.New("model stream incomplete; partial download retained")
		}
		if err = f.Sync(); err != nil {
			return v, err
		}
	}
	if err = verify(ctx, partial, want); err != nil {
		return v, err
	}
	if err = f.Close(); err != nil {
		return v, err
	}
	if err = os.Rename(partial, path); err != nil {
		return v, err
	}
	return record(path, marker, want)
}

func verify(ctx context.Context, path string, want File) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, 1<<20)
	var size int64
	for {
		if err = ctx.Err(); err != nil {
			return err
		}
		n, e := f.Read(buf)
		h.Write(buf[:n])
		size += int64(n)
		if errors.Is(e, io.EOF) {
			break
		}
		if e != nil {
			return e
		}
	}
	if size != want.Size || hex.EncodeToString(h.Sum(nil)) != want.SHA256 {
		return errors.New("model file does not match pinned size and SHA-256; retained for inspection")
	}
	return nil
}

func record(path, marker string, want File) (VerifiedFile, error) {
	info, err := os.Stat(path)
	if err != nil {
		return VerifiedFile{}, err
	}
	v := VerifiedFile{File: want, Modified: info.ModTime().UnixNano()}
	return v, WriteJSON(marker, v)
}

func WriteJSON(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".nemoclaw-write-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err = f.Write(b); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		return nil
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
