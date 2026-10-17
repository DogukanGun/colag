import { z } from "zod";
import { specSchema } from "../../protocol/src/demo.ts";
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
    name: "create_demo_video",
    description:
      "Write a demo video of the app this room builds (the current build: the candidate, or main once merged). " +
      "Colag starts the app with `npm run <app.start>` (plus app.api.start) in a sandbox without internet, records your steps " +
      "in a browser with a visible cursor, speaks each step's `say` line with a cheerful voice (en: Eve, de: Ara), adds a music bed, " +
      "and publishes an MP4 (plus a GIF preview and a thumbnail with a play button for e-mails) in the room's Artifacts. " +
      "Write one short, upbeat line per step (about 6–14 words), aim for 30–60 seconds in total, use stable selectors " +
      "(text=Sign in, role=button[name=\"Sign in\"], #email) and goto paths inside the app only. Creates a draft; then call render_demo_video.",
    schema: {
      title: z.string().describe("The video title, e.g. 'Sign-up in 30 seconds'"),
      language: z.enum(["en", "de"]).optional().describe("Voice language (default en)"),
      music: z.boolean().optional().describe("A cheerful music bed under the voice (default true)"),
      emailKit: z.boolean().optional().describe("Also make a GIF preview and a thumbnail for e-mails (default true)"),
      spec: specSchema.describe("How to start the app and what to show"),
    },
    remote: true,
  },
  {
    name: "update_demo_video",
    description: "Change a demo video's title, language, music, e-mail kit or script (it goes back to draft)",
    schema: {
      demoId: z.string(),
      title: z.string().optional(),
      language: z.enum(["en", "de"]).optional(),
      music: z.boolean().optional(),
      emailKit: z.boolean().optional(),
      spec: specSchema.optional(),
    },
    remote: true,
  },
  {
    name: "render_demo_video",
    description:
      "Record and render a demo video (a few minutes). One render per room at a time and a daily limit. Poll get_demo_video for the result; " +
      "if a step fails, the error names the step and a screenshot is kept, so fix that step with update_demo_video and render again.",
    schema: { demoId: z.string() },
    remote: true,
  },
  {
    name: "get_demo_video",
    description: "The demo videos of this room, or one of them: status, progress, error and file links",
    schema: { demoId: z.string().optional() },
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