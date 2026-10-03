# Colag

A local, single-page workspace for collaborative software-engineering agents. Claude Code sessions share a plan and structured tasks, work in isolated Git branches, and submit a tested integration candidate for human approval.

## Start

Requires Node 22+, pnpm, Git, Docker Desktop, and an authenticated Claude Code installation.

```sh
pnpm install
cp .env.example .env
pnpm infra:up
docker pull node:22-alpine
claude auth status
pnpm dev
```

Open the web app and sign in with your email. In development the sign-in response includes the one-time code. Migrations run at service startup. The service binds to `COLAG_HOST` (loopback unless you set it) and the browser origin comes from `COLAG_PUBLIC_ORIGIN`.

Ports: UI 3000, API 4310, Yjs 4311, A2A 4312, optional A2A fixture 4320. PostgreSQL and Redis defaults are 54329 and 63799. You can use existing local PostgreSQL/Redis servers by setting `.env`; use a dedicated database. Service startup errors appear in the page. Generated code never falls back to host execution when Docker is unavailable.

## Use

1. Enter **Build authentication.** and start collaboration.
2. Review the coordinator's shared plan and tasks, then choose **Approve plan**.
3. Architect, Backend and Frontend work through dependency gates in separate worktrees. QA reviews the combined commit. Tests run in a network-isolated container.
4. Open **Changes** to inspect the diff, reviews and test artifacts.
5. Choose **Approve & merge tested commit**. Only the disposable repository's `main` changes; there is no remote push.

The sample has a fixed Node HTTP adapter and React entrypoint; agents implement the authentication module and forms. It is a demonstration, not production authentication. Run state, decisions, events, artifacts and document updates persist. Interrupted work is marked blocked on restart and needs an explicit retry. Agent failure and stop controls never fabricate completion. Repair attempts are capped at two per run.

`.colag/` holds disposable repositories, worktrees, and runtime files. It is ignored by Git. Never point the service at an existing production repository. Each room gets its own disposable repo. Roles and capabilities are resource data; the included authentication workflow selects its default specialists by role.

## Protocol

- [Architecture](docs/architecture.md)
- [Domain model](docs/domain-model.md)
- [API contracts](docs/api.md)
- [Public TypeScript contracts](packages/protocol/src/index.ts)

All mutations use project-scoped identities and idempotency keys. PostgreSQL transactions arbitrate claims and persist events. Redis holds expiring presence and lease caches; durable ownership does not depend on Redis being available. Shared documents use Tiptap/Yjs/Hocuspocus. Agents append sections rather than replacing concurrent human edits.

Claude's native tools are disabled. The explicit MCP server exposes project tools and service-mediated workspace operations. Test containers have read-only workspace mounts, no network, no host credentials, CPU/memory limits, and no Docker socket. Agent tokens are revoked at session end. Only the local human can approve the plan or merge.

### A2A

The official `@a2a-js/sdk` 1.2.1 provides A2A v1 JSON-RPC. Discover at `http://127.0.0.1:4312/.well-known/agent-card.json`. Obtain an external bearer token using authenticated `POST /api/v1/external-token`. Supply it as an Authorization header to the SDK client. Incoming messages create runs that still require human approval; task IDs map durably to runs. Polling and cancellation use the same run state. Artifact contents are returned in A2A tasks.

```sh
pnpm demo:a2a
pnpm exec tsx scripts/check-a2a.ts
```

The separate local A2A fixture returns a deterministic checklist and is explicitly not an AI reviewer. Real agents can invoke `delegate_external` through MCP against `COLAG_A2A_ENDPOINT`; configure `COLAG_A2A_TOKEN` when needed. It cannot approve or merge local code.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm build
DATABASE_URL=postgres://127.0.0.1:5432/colag_test COLAG_DATABASE_TESTS=1 pnpm test
COLAG_TEST_DATABASE_URL=postgres://127.0.0.1:5432/colag_test pnpm test:integration
pnpm test:browser
pnpm test:claude
```

Create the dedicated `colag_test` database before integration tests. The deterministic integration test uses real PostgreSQL, real Git worktrees and the A2A SDK, but injects fixture agents and test results. Test injection is rejected outside `NODE_ENV=test`. Browser checks use installed Chrome and require the app running; they verify two-session document synchronization and responsive widths. The Claude smoke check uses your real authenticated account and only reads the project.

A complete live acceptance run uses the normal UI and Docker. Approval gates intentionally remain human actions. The framework does not approve its own generated plan or merge on your behalf.

## Current boundaries

One local project and disposable authentication workflow, local human identity, one independent QA review, and explicit external A2A endpoints. No hosted accounts, arbitrary repository import, marketplace, remote push, production deployment or Kubernetes.
