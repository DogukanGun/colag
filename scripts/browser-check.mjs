import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const email = `browser-${Date.now()}@colag.test`;
const requested = await page.request.post(
  "http://127.0.0.1:3000/api/v1/auth/request",
  { data: { email } },
);
const code = (await requested.json()).code;
if (!code) throw new Error("Development sign-in code was not returned");
await page.goto("http://127.0.0.1:3000");
await page.getByLabel("Email").fill(email);
await page.getByRole("button", { name: "Send code" }).click();
await page.getByLabel("Sign-in code").fill(code);
await page.getByRole("button", { name: "Continue" }).click();
await page.getByLabel("Your name").fill("Browser User");
await page.getByRole("button", { name: "Enter Colag" }).click();
await page.getByRole("button", { name: "Bring your agent" }).click();
await page.getByRole("dialog", { name: "Connect a client" }).waitFor();
await page.getByRole("button", { name: "Close" }).click();
await page.goto("http://127.0.0.1:3000");
await page.getByRole("button", { name: "Use a Colag agent" }).click();
await page.getByRole("dialog", { name: "Command an agent" }).waitFor();
await page.getByLabel("Command").fill("Draft a short plan.");
await page.getByRole("button", { name: "Send command" }).click();
await page.locator(".tiptap").waitFor({ timeout: 30000 });
const roomUrl = page.url();
const second = await context.newPage();
await second.goto(roomUrl);
await second.locator(".tiptap").waitFor();
const text = "Browser verification " + crypto.randomUUID();
const editor = page.locator(".tiptap");
await editor.click();
await editor.press("ControlOrMeta+End");
await editor.press("Enter");
await editor.pressSequentially(text);
await second
  .locator(".tiptap")
  .filter({ hasText: text })
  .waitFor({ timeout: 10000 });
console.log("Two-session Yjs synchronization passed");
await editor.press("Shift+Home");
await editor.press("Backspace");
await editor.press("Backspace");
await second.waitForFunction(
  (marker) => !document.querySelector(".tiptap")?.textContent?.includes(marker),
  text,
);
await page.screenshot({ path: ".colag/workspace-desktop.png", fullPage: true });
for (const width of [375, 768]) {
  await page.setViewportSize({ width, height: 950 });
  await page.screenshot({
    path: `.colag/workspace-${width}.png`,
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  if (overflow) throw new Error(`Overflow at ${width}px`);
}
await page.setViewportSize({width:1440,height:1050});
await page.getByRole('button',{name:/^Changes/}).click();
if(await page.locator('.resource-row').count()){
 await page.locator('.resource-row').first().click();
 await page.locator('.monaco-diff-editor').waitFor({timeout:20000});
 await page.screenshot({path:'.colag/change-review.png',fullPage:true});
 await page.keyboard.press('Escape');
 if(await page.getByRole('dialog').count())throw new Error('Escape did not close review drawer');
 console.log('Local Monaco diff and drawer keyboard dismissal passed');
}
await page.getByRole("button", { name: "Browser User account" }).click();
await page.getByRole("button", { name: "Sign out" }).click();
await page.getByRole("heading", { name: "Sign in to Colag" }).waitFor();
await page.goto(roomUrl);
await page.getByRole("heading", { name: "Sign in to Colag" }).waitFor();
console.log("Sign-out hides the room until the next sign-in");
console.log("Responsive widths passed; browser errors:", errors);
if (errors.length) throw new Error(errors.join("\n"));
await browser.close();
