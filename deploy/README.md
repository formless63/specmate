# deploy

The batteries-included deployment and managed startup. Implement the service/initialization contract in docs/OPERATIONS.md. No untested Compose placeholder is shipped. The first deployment task creates a real runnable stack with pinned images, generated secrets, and idempotent startup.

This directory is an implementation boundary, not a claim that the subsystem is built.
Start with `docs/ARCHITECTURE.md`, the relevant capability IDs and assigned task.
