import express from "express";
import { Task } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  AgentEvent,
  type AgentExecutor,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import { AgentCard } from "@a2a-js/sdk";
const port = 4320;
const card = AgentCard.fromJSON({
  name: "Local checklist reviewer",
  description:
    "Independent deterministic interoperability fixture; not an AI reviewer.",
  version: "0.1.0",
  supportedInterfaces: [
    {
      url: `http://127.0.0.1:${port}/a2a`,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    },
  ],
  capabilities: { streaming: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "checklist",
      name: "Review checklist",
      description: "Returns an authentication review checklist",
      tags: ["review"],
    },
  ],
});
const executor: AgentExecutor = {
  async execute(ctx, bus) {
    bus.publish(
      AgentEvent.task(
        Task.fromJSON({
          id: ctx.taskId,
          contextId: ctx.contextId,
          status: { state: "TASK_STATE_COMPLETED" },
          history: [],
          artifacts: [
            {
              artifactId: "checklist",
              name: "Authentication checklist",
              parts: [
                {
                  text: "Verify password hashing, invalid credential handling, unique tokens, logout invalidation, accessible labels and error messages. This deterministic checklist is not code approval.",
                },
              ],
            },
          ],
        }),
      ),
    );
    bus.finished();
  },
  async cancelTask(_id, bus) {
    bus.finished();
  },
};
const handler = new DefaultRequestHandler(
  card,
  new InMemoryTaskStore(),
  executor,
);
const app = express();
app.use(express.json());
app.use(
  "/.well-known/agent-card.json",
  agentCardHandler({ agentCardProvider: handler }),
);
app.use(
  "/a2a",
  jsonRpcHandler({
    requestHandler: handler,
    userBuilder: UserBuilder.noAuthentication,
  }),
);
app.listen(port, "127.0.0.1", () =>
  console.log(`A2A fixture: http://127.0.0.1:${port}`),
);
