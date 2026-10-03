# API v1

The browser signs in with POST /api/v1/auth/request and POST /api/v1/auth/verify, which sets an HttpOnly SameSite `colag_session` cookie. POST /api/v1/auth/logout revokes it. GET /api/v1/me returns the user and rejects agent tokens. Hosted agents and external A2A clients use scoped bearer tokens. Room MCP clients use a separate revocable bearer on `/mcp`. A session cookie does not authenticate MCP. Mutating requests require Idempotency-Key. Errors use {error, code}. Versioned updates reject stale versions with 409.

- GET /api/v1/health: PostgreSQL, Redis, Docker and Claude readiness.
- GET/POST /api/v1/projects; GET /api/v1/projects/:id: project snapshot.
- GET /api/v1/projects/:id/events?after=sequence: SSE durable replay.
- POST /api/v1/projects/:id/commands: typed command union for agent registration, tasks/create/claim/update/delegate, decisions/create/update, artifacts/create, changes/propose, reviews/create, locks/acquire/release and runs/start/approve/stop/retry/merge.
- GET /api/v1/projects/:id/changes/:changeId/diff: original and modified text per file.
- GET /api/v1/projects/:id/artifacts/:artifactId: artifact content.
- GET /api/v1/projects lists the signed-in user’s rooms. POST creates one and makes that user the owner.
- POST /api/v1/projects/:id/invites and POST /api/v1/invites/accept join another user as a member.
- POST /api/v1/projects/:id/connections returns a room MCP URL and token once. DELETE revokes it.
- POST /api/v1/projects/:id/commands accepts `agent.prompt` from a member. MCP cannot approve or merge.
- POST /api/v1/projects/:id/commands accepts `board.submit` from a member. Atlas appends a design analysis to the shared board and does not replace it.

The protocol package exports request, response, entity and event types. Unknown commands are rejected. Dependency validation, permissions, transition rules and event creation are shared across adapters. Run start performs prerequisite checks before invoking any model.

Hocuspocus accepts the same credential in connection authentication and restricts document names to project IDs. Only project members with document write permission may edit.

MCP stdio tools expose project inspection, tasks, decisions, delegation, artifact publishing, document edits, workspace files, sandbox tests and change proposals. The stdio bridge forwards the bound bearer token; file and process operations remain service-owned.

A2A publishes /.well-known/agent-card.json and the SDK JSON-RPC endpoint /a2a. Agent cards advertise task submission and artifacts. Authenticated requests map to internal runs or delegated tasks, with durable external/internal IDs. A2A cancellation calls the same stop command; terminal tasks are not restarted. An independent local sample A2A reviewer demonstrates outbound delegation. External plans still require human approval.

## Local slice behavior

The UI is a signed-in home with three entries into a room: connect your own client, command one hosted agent, or make an app together on the shared board. Arbitrary repository import is deferred. Add tasks before approving a plan. Agent file edits are restricted to that task's exact file allowlist. Review creation is restricted to the current candidate and its run; code authors cannot approve their own change. Agent document writes append a section to preserve concurrent human edits. Git operations are service-owned; merge uses compare-and-swap and recovers an already-applied candidate after a database interruption.

A2A v1 is served on the separate loopback port 4312, using the SDK's Agent Card and JSON-RPC routers. The outbound checklist fixture uses port 4320. `POST /api/v1/external-token` requires a human session and returns an external identity with read/start/stop privileges, never approve/merge privileges.
