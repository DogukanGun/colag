# Validation record

Validated locally on 26 September 2026.

## Passed

- TypeScript checks for the service, protocol, runtime, adapters and Next.js app.
- Next.js production build.
- Ten automated tests, including PostgreSQL concurrent claims and atomic audit writes, idempotent replay, dependency gates/cycles, permission denial, expired leases, stale merge approval rejection, real Git conflict detection/resolution, symlink/traversal rejection, hard process deadlines and cancellation.
- Deterministic end-to-end integration against real PostgreSQL and Git: proposed plan → approval gate → dependency scheduling → isolated branches → fixture tests → independent fixture review → exact-commit merge. Fixture model and test-runner outputs are explicitly injected only in the test process.
- Independent A2A v1 SDK client: discovery, authenticated inbound submission, durable run mapping, status retrieval and cancellation.
- Separate outbound A2A checklist process and artifact exchange.
- Real Claude Code session connected to the MCP stdio bridge and inspected the project.
- Real Claude coordinator generated a plan; Architect and Frontend completed real changes in isolated worktrees. Backend wrote its implementation before being interrupted at sandbox execution.
- Browser checks: two-session Yjs synchronization, 375/768/1440 pixel layouts, no browser exceptions.

## Live acceptance blocker

Docker Desktop initially did not respond. After the authorized restart, engine queries and the public Node image pull succeeded, but containers stayed in `Created` and container start requests timed out. A minimal Node container without workspace mounts failed the same way. Docker Desktop UI inspection was blocked by the locked Mac.

The live acceptance run is preserved and blocked, not marked tested, reviewed, or merged. Its plan approval is attributed to `acceptance-test`, not the local human. No generated application code was executed on the host. Resume using Retry after Docker can start containers.

The runner now checks actual container execution before starting or retrying a run, separates create/start/wait/log phases, disables implicit image pulls, and enforces hard process deadlines that do not depend on a child's SIGTERM handling.
