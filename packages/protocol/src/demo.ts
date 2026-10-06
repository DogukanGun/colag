import { z } from "zod";

/** npm script names only: the app is started with `npm run <script>` inside the preview container. */
const script = z
  .string()
  .regex(/^[a-zA-Z0-9:_.-]{1,60}$/, "An npm script name, such as dev or dev:web");
const port = z.number().int().min(1024).max(65535);
/** A path inside the app, never another site. */
const appPath = z
  .string()
  .max(300)
  .regex(/^\/(?!\/)[^\s\\]*$/, "A path inside the app that starts with /, such as /login");

export const STEP_ACTIONS = ["goto", "click", "type", "press", "hover", "scroll", "wait"] as const;
export const MAX_STEPS = 40;
export const MAX_LINE_WORDS = 40;
/** About three minutes of speech at a cheerful pace (2.6 words a second). */
export const MAX_TOTAL_WORDS = 470;

export const stepSchema = z
  .object({
    do: z.enum(STEP_ACTIONS),
    target: z.string().min(1).max(300).optional(),
    value: z.string().max(400).optional(),
    say: z.string().max(400).optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    const needsTarget = ["click", "type", "hover"].includes(step.do);
    if (needsTarget && !step.target)
      ctx.addIssue({ code: "custom", message: `${step.do} needs a target (a CSS selector, text=… or role=…)` });
    if (step.do === "goto" && !appPath.safeParse(step.value).success)
      ctx.addIssue({ code: "custom", message: "goto needs a value: a path inside the app, such as /login" });
    if (step.do === "type" && step.value === undefined)
      ctx.addIssue({ code: "custom", message: "type needs a value: the text to type" });
    if (step.do === "press" && !/^[A-Za-z0-9+]{1,30}$/.test(step.value ?? ""))
      ctx.addIssue({ code: "custom", message: "press needs a key, such as Enter or Tab" });
    if (["scroll", "wait"].includes(step.do) && step.value !== undefined && !/^-?\d{1,5}$/.test(step.value))
      ctx.addIssue({ code: "custom", message: `${step.do} takes a number (${step.do === "wait" ? "milliseconds" : "pixels"})` });
    if (step.do === "wait" && Number(step.value ?? 0) > 10_000)
      ctx.addIssue({ code: "custom", message: "wait is at most 10000 ms" });
    if (step.target && /^(js|javascript|eval)\s*=/i.test(step.target))
      ctx.addIssue({ code: "custom", message: "Script selectors are not allowed" });
    if (step.say && words(step.say) > MAX_LINE_WORDS)
      ctx.addIssue({ code: "custom", message: `A voice line has at most ${MAX_LINE_WORDS} words` });
  });

export const specSchema = z
  .object({
    app: z
      .object({
        start: script,
        port,
        path: appPath.optional(),
        readyPath: appPath.optional(),
        api: z.object({ start: script, port }).strict().optional(),
      })
      .strict(),
    viewport: z.enum(["1920x1080", "1280x720"]).optional(),
    steps: z.array(stepSchema).min(1).max(MAX_STEPS),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const total = spec.steps.reduce((n, s) => n + (s.say ? words(s.say) : 0), 0);
    if (total > MAX_TOTAL_WORDS)
      ctx.addIssue({ code: "custom", message: `The voice-over has ${total} words; keep it under ${MAX_TOTAL_WORDS} (about three minutes)` });
    if (!spec.steps.some((s) => s.say?.trim()))
      ctx.addIssue({ code: "custom", message: "Give at least one step a voice line (say)" });
    if (spec.app.api && spec.app.api.port === spec.app.port)
      ctx.addIssue({ code: "custom", message: "The app and its API need different ports" });
  });

export type DemoSpec = z.infer<typeof specSchema>;
export type DemoStep = z.infer<typeof stepSchema>;

export const settingsSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    language: z.enum(["en", "de"]).default("en"),
    music: z.boolean().default(true),
    emailKit: z.boolean().default(true),
  })
  .strict();

export function words(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Readable validation errors for the coder ("steps.3: click needs a target"). */
export function issues(error: z.ZodError) {
  return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
}

export function parseSpec(input: unknown): { ok: true; spec: DemoSpec } | { ok: false; errors: string[] } {
  const parsed = specSchema.safeParse(input);
  return parsed.success ? { ok: true, spec: parsed.data } : { ok: false, errors: issues(parsed.error) };
}

/** The scripts the spec starts must exist in the app's package.json. */
export function missingScripts(spec: DemoSpec, scripts: Record<string, string> | undefined) {
  const wanted = [spec.app.start, spec.app.api?.start].filter(Boolean) as string[];
  return wanted.filter((name) => !scripts || typeof scripts[name] !== "string");
}
