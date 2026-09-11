// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package openshell

import (
	"context"
	"errors"
	"time"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
)

// Remove rechecks the binding immediately before a name-addressed upstream
// delete. OpenShell 0.0.116 does not expose a delete identity/version precondition.
// A failed request is never retried here; the next explicit destroy reconciles it.
func Remove(ctx context.Context, c Client, kind string, want Row) error {
	if want["id"] == "" {
		return errors.New("deletion requires a durable resource binding")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	got, err := ObserveRemoval(ctx, c, kind, want["workspace"], want["name"])
	if err != nil || got == nil {
		return err
	}
	if err = VerifyIdentity(want, got); err != nil {
		return err
	}
	switch kind {
	case "sandbox":
		err = c.Sandboxes().Delete(ctx, want["workspace"], want["name"])
	case "route":
		// The prototype's logical primary is OpenShell's unnamed default route.
		err = c.Inference().DeleteRoute(ctx, want["workspace"], "")
	case "provider":
		err = c.Providers().Delete(ctx, want["workspace"], want["name"])
	default:
		return errors.New("unsupported resource deletion")
	}
	if err != nil && !v1.IsNotFound(err) {
		return remoteError("delete "+kind, err)
	}
	for {
		got, err = ObserveRemoval(ctx, c, kind, want["workspace"], want["name"])
		if err != nil || got == nil {
			return err
		}
		if err = VerifyIdentity(want, got); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return errors.New("deletion remains unconfirmed; retain state and rerun destroy")
		case <-time.After(200 * time.Millisecond):
		}
	}
}
