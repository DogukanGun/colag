import { z } from "zod";
export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  /** Exposed on the room's Streamable HTTP MCP. Approve and merge are never remote. */
  remote: boolean;
}
export const tools: ToolSpec[] = [
  {
    name: "inspect_project",
    description: "Read the shared room, tasks and decisions",
    schema: {},
    remote: true,
  },
  {
    name: "claim_task",
    description: "Atomically claim your assigned task",
    schema: { taskId: z.string() },
    remote: true,
  },
  {
    name: "update_task",
    description: "Block your task with a concrete reason when you cannot proceed",
    schema: {
      taskId: z.string(),
      status: z.literal("blocked"),
      reason: z.string(),
    },
    remote: true,
  },
  {
    name: "read_document",
    description: "Read the shared plan or design board, including algorithms and diagram source",
    schema: {},
    remote: true,
  },
  {
    name: "write_document",
    description: "Append a section to the shared plan without replacing concurrent edits",
    schema: { text: z.string() },
    remote: true,
  },
  {
    name: "create_decision",
    description: "Record an architecture decision",
    schema: { title: z.string(), description: z.string() },
    remote: true,
  },
  {
    name: "create_task",
    description: "Create a task in this run",
    schema: {
      title: z.string(),
      description: z.string(),
      role: z.string(),
      dependencies: z.array(z.string()),
      relatedFiles: z.array(z.string()),
    },
    remote: true,
  },
  {
    name: "delegate_task",
    description: "Delegate an inactive owned task",
    schema: {
      taskId: z.string(),
      targetAgentId: z.string(),
      reason: z.string(),
    },
    remote: true,
  },
  {
    name: "publish_artifact",
    description: "Publish useful output",
    schema: { name: z.string(), content: z.string() },
    remote: true,
  },
  {
    name: "list_files",
    description: "List files in the assigned workspace",
    schema: {},
    remote: true,
  },
  {
    name: "read_file",
    description: "Read a file from the assigned workspace",
    schema: { path: z.string() },
    remote: true,
  },
  {
    name: "write_file",
    description: "Write an allowed task file",
    schema: { path: z.string(), content: z.string() },
    remote: true,
  },
  {
    name: "propose_change",
    description: "Commit the task workspace and record a change",
    schema: {},
    remote: true,
  },
  {
    name: "run_tests",
    description: "Run the fixed authentication test suite in a network-isolated container",
    schema: {},
    remote: false,
  },
  {
    name: "inspect_diff",
    description: "Read the current integration candidate diff",
    schema: {},
    remote: false,
  },
  {
    name: "submit_review",
    description: "Review the exact candidate commit",
    schema: {
      status: z.enum(["approved", "changes_requested"]),
      comments: z.string(),
    },
    remote: false,
  },
  {
    name: "delegate_external",
    description: "Ask the configured external A2A reviewer for feedback",
    schema: { message: z.string() },
    remote: false,
  },
];
export const remoteTools = () => tools.filter((tool) => tool.remote);