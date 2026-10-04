<p align="center">
  <strong>People and agents · one shared plan</strong>
</p>

<h1 align="center">The whole room.<br>One Colag.</h1>

<p align="center">
  A room where the people and the coding client build the same product.<br>
  The plan, the board, and the coder stay in one place.
</p>

<p align="center">
  <a href="https://colag-eight.vercel.app"><strong>Open Colag</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/DogukanGun/colag/blob/main/docs/product-flows.md">User flows</a>
</p>

https://github.com/user-attachments/assets/bbaf70d9-da41-4a24-8845-f372a8509a44

<p align="center">Two minutes, with sound. Unmute to hear it.</p>

The demo is the product, not a mock. A person signs in, connects Cursor as the coder, and the room stays closed until that client is in. On the board they write the requirements, the matching algorithm, a flowchart, and a sketch of the ride. A second person opens the same room and sees the same drawing.

## What you can do

| | Today | |
| --- | --- | --- |
| **Bring your agent** | Cursor or Claude Code joins over Colag’s own MCP and is the coder for the room. | Live |
| **Make an app together** | One board for requirements, algorithms, Mermaid diagrams, and drawings. Everyone in the room writes the same document. | Live |
| **Use a Colag agent** | Atlas, Ada, Forge, Pixel, and Sentinel stay on the page. They are not a way to start a room yet. | Coming soon |

A member still approves and merges. The connected client cannot.

```mermaid
flowchart LR
  user[Signed-in person]
  gate[Who builds this?]
  client[Cursor or Claude Code]
  room[Room]
  plan[Shared plan]
  board[Design board]
  review[Approve and merge]

  user --> gate
  gate --> client
  client -->|MCP| room
  room --> plan
  room --> board
  plan --> review
  board --> review
```

## The room stays closed until the coder is in

Creating a room asks who builds it. The working answer is your own client. A Colag agent is shown, labeled coming soon, and cannot be chosen.

1. Name the client. Cursor or Claude Code.
2. Copy the setup. The token is shown once, off to the side of the room.
3. Enter the room only after that connection exists.
4. The coder is named in the room. Replace them with another client. The coder is not revoked out from under the work.
5. Write the plan together. Code goes through a claimed task. A member reviews the diff and merges. The client cannot.

```mermaid
sequenceDiagram
  participant Member
  participant Room
  participant Client as Cursor or Claude Code
  Member->>Room: Who builds this?
  Room-->>Member: The room stays closed
  Member->>Room: Connect the client
  Room-->>Member: Coder is named
  Client->>Room: Plan, tasks, and claimed files
  Member->>Room: Replace the coder, or approve and merge
  Note over Client,Room: The client cannot approve, merge, or be revoked
```

Public MCP for the live product: `https://colag.2-28-123-220.sslip.io/mcp`

## One board, the same picture for everyone

**Make an app together** opens a design board on the same live document. Requirements, an algorithm, a diagram, and a drawing are blocks in that document. Yjs keeps them in sync. What one person writes is what the next person sees, including the sketch.

Submitting the board to a hosted agent for an analysis, a page map, and a BPMN diagram per feature waits with the hosted agents. The board itself is the place the product gets drawn.

```mermaid
flowchart TD
  people[People in the room]
  req[Requirements]
  algo[Algorithm]
  diagram[Diagram]
  sketch[Drawing]
  same[Same document for everyone]

  people --> req --> same
  people --> algo --> same
  people --> diagram --> same
  people --> sketch --> same
```

## Accounts, rooms, review

- **You sign in as yourself.** Email and a one-time code. The first code creates the user. The browser session is an HttpOnly cookie, separate from the agent token and the MCP token.
- **A room is a project.** You own the rooms you create. Other people join by invite. A member of one room cannot open another.
- **The plan is shared.** One Tiptap document per room. Agents append. They do not replace a sentence someone else is still typing.
- **Reviewed changes.** Coding work uses a branch and a worktree per task. Tests run in a network-isolated container. A member approves the plan and merges a tested commit. There is no remote push. A failure is never marked complete.

Step-by-step rules, including which token opens what, are in [User flows](docs/product-flows.md).

## Start

Requires Node 22+, pnpm, Git, Docker, and one model provider for the hosted agents: an authenticated Claude Code installation, or any OpenAI-compatible endpoint such as Nebius Token Factory. See [Model providers](#model-providers).

```sh
pnpm install
cp .env.example .env
pnpm infra:up
docker pull node:22-alpine
claude auth status
pnpm dev
```

### Model providers

Hosted Colag agents run on the provider named in `COLAG_MODEL_PROVIDER`. Everything above the model is the same on both paths: the plan, claimed tasks, worktrees, the sandboxed tests, and the human approve-and-merge gate.

| Provider | What runs | Configure |
| --- | --- | --- |
| `claude` (default) | The Claude Code CLI on this host, with built-in tools disabled and only Colag's MCP tools. | `claude auth login`, optional `CLAUDE_BIN` |
| `openai` | A tool-calling loop against any OpenAI-compatible chat endpoint. Tested with Nebius Token Factory serving NVIDIA Nemotron; works with a vLLM server on AMD Developer Cloud or a local server. | `COLAG_MODEL_BASE_URL`, `COLAG_MODEL_API_KEY`, `COLAG_MODEL_NAME` |

```sh
COLAG_MODEL_PROVIDER=openai
COLAG_MODEL_BASE_URL=https://api.tokenfactory.nebius.com/v1
COLAG_MODEL_API_KEY=...
COLAG_MODEL_NAME=nvidia/nemotron-3-super-120b-a12b
```

On the `openai` path the model only sees Colag's tool catalog, and each tool call goes through the same authorized HTTP tool endpoint the MCP bridge uses. Token usage per run is reported in the agent's result event. `GET /api/v1/health` reports the active provider under the `model` check.

Open the web app and sign in with your email. In development the sign-in response includes the one-time code. Migrations run at service startup. The service binds to `COLAG_HOST` (loopback unless you set it) and the browser origin comes from `COLAG_PUBLIC_ORIGIN`.

Ports: UI 3000, API 4310, Yjs 4311, A2A 4312, optional A2A fixture 4320. PostgreSQL and Redis defaults are 54329 and 63799. You can point `.env` at existing local servers; use a dedicated database. Generated code never falls back to host execution when Docker is unavailable.

The live app is [colag-eight.vercel.app](https://colag-eight.vercel.app). It talks to the hosted API. Production does not print login codes. Codes are emailed when mail is configured.

## Sample build

A room can still run the disposable authentication sample when an agent runtime is available. The sample has a fixed Node HTTP adapter and a React entrypoint. Agents implement the authentication module and forms. It is a demonstration, not production authentication.

1. Describe the change and start the run.
2. Review the shared plan and tasks, then choose **Approve plan**.
3. Architect, Backend, and Frontend work through dependency gates in separate worktrees. QA reviews the combined commit. Tests run in a network-isolated container.
4. Open **Changes** to inspect the diff, reviews, and test artifacts.
5. Choose **Approve & merge tested commit**.

Run state, decisions, events, artifacts, and document updates persist. Interrupted work is marked blocked on restart and needs an explicit retry. Repair attempts are capped at two per run.

`.colag/` holds disposable repositories, worktrees, and runtime files. It is ignored by Git. Never point the service at an existing production repository. Each room gets its own disposable repo.

## Docs

- [User flows](docs/product-flows.md)
- [Architecture](docs/architecture.md)
- [Domain model](docs/domain-model.md)
- [API](docs/api.md)
- [Public TypeScript contracts](packages/protocol/src/index.ts)

All mutations use project-scoped identities and idempotency keys. PostgreSQL transactions arbitrate claims and persist events. Redis holds expiring presence and lease caches; durable ownership does not depend on Redis being available. Shared documents use Tiptap, Yjs, and Hocuspocus.

Claude's native tools are disabled. The explicit MCP server exposes project tools and service-mediated workspace operations. Test containers have read-only workspace mounts, no network, no host credentials, CPU and memory limits, and no Docker socket. Agent tokens are revoked at session end. Only a member of the room can approve the plan or merge.

### A2A

The official `@a2a-js/sdk` 1.2.1 provides A2A v1 JSON-RPC. Discover at `http://127.0.0.1:4312/.well-known/agent-card.json`. Obtain an external bearer token with authenticated `POST /api/v1/external-token`. Supply it as an Authorization header to the SDK client. Incoming messages create runs that still require human approval; task IDs map durably to runs. Polling and cancellation use the same run state. Artifact contents are returned in A2A tasks.

```sh
pnpm demo:a2a
pnpm exec tsx scripts/check-a2a.ts
```

The separate local A2A fixture returns a deterministic checklist and is explicitly not an AI reviewer. Real agents can invoke `delegate_external` through MCP against `COLAG_A2A_ENDPOINT`. Configure `COLAG_A2A_TOKEN` when needed. It cannot approve or merge local code.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm build
DATABASE_URL=postgres://127.0.0.1:5432/colag_test COLAG_DATABASE_TESTS=1 pnpm test
COLAG_TEST_DATABASE_URL=postgres://127.0.0.1:5432/colag_test pnpm test:integration
pnpm test:browser
pnpm test:model
```

Create the dedicated `colag_test` database before integration tests. The deterministic integration test uses real PostgreSQL, real Git worktrees, and the A2A SDK, and injects fixture agents and test results. Test injection is rejected outside `NODE_ENV=test`. Browser checks use installed Chrome and require the app running. They verify two-session document synchronization and responsive widths. The model smoke check runs one hosted agent against the configured provider and only reads the project.

A complete live acceptance run uses the normal UI and Docker. Approval gates stay human actions. The framework does not approve its own plan or merge on your behalf.

## Boundaries

Accounts, invites, and rooms are in. Each room is one disposable repository and one shared document. The coder is a connected client, and the room does not open without one. Hosted Colag agents are visible and marked coming soon. One independent QA review. External A2A endpoints are explicit.

Not in this product: billing, importing an existing repository, a marketplace of third-party MCP servers, a model key per user, remote push, or Kubernetes.
