import type { Locator, Page } from "@playwright/test";

const CURSOR = `
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
  <path d="M6 3 L6 22 L11.2 17.2 L15.4 25 L18.6 23.5 L14.3 15.6 L22 15.2 Z" fill="#ffffff" stroke="#1a1a1a" stroke-width="1.4" stroke-linejoin="round"/>
</svg>`;

export async function installHumanCursor(page: Page) {
  await page.addInitScript(`(() => {
    const svg = ${JSON.stringify(CURSOR)};
    const boot = () => {
      if (document.getElementById("sales-cursor")) return;
      const style = document.createElement("style");
      style.textContent = "#sales-cursor{position:fixed;z-index:2147483647;left:0;top:0;width:32px;height:32px;pointer-events:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.8))} .sales-ripple{position:fixed;width:36px;height:36px;margin:-18px 0 0 -18px;border:2px solid rgba(255,255,255,.9);border-radius:50%;pointer-events:none;z-index:2147483646} .snippet{filter:blur(14px)}";
      const cursor = document.createElement("div");
      cursor.id = "sales-cursor";
      cursor.innerHTML = svg;
      const hideSecrets = () => {
        document.querySelectorAll("pre.snippet").forEach((node) => {
          if (!node.textContent || !node.textContent.includes("Connection setup is copied off camera."))
            node.textContent = "Connection setup is copied off camera.";
        });
      };
      document.documentElement.append(style, cursor);
      window.addEventListener("mousemove", (event) => {
        cursor.style.transform = "translate(" + event.clientX + "px," + event.clientY + "px)";
      }, true);
      new MutationObserver(hideSecrets).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      hideSecrets();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  })()`);
}

function ease(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

export class Hand {
  x = 220;
  y = 180;

  constructor(
    private page: Page,
    private pace = 1,
  ) {}

  async pause(ms: number) {
    await this.page.waitForTimeout(Math.max(0, ms * this.pace));
  }

  private async show(x: number, y: number) {
    await this.page
      .evaluate(
        ({ x, y }) => {
          const cursor = document.getElementById("sales-cursor");
          if (cursor) cursor.style.transform = `translate(${x}px, ${y}px)`;
        },
        { x, y },
      )
      .catch(() => undefined);
  }

  async move(x: number, y: number) {
    const dx = x - this.x;
    const dy = y - this.y;
    const length = Math.hypot(dx, dy);
    if (length < 2) {
      this.x = x;
      this.y = y;
      return;
    }
    const nx = -dy / length;
    const ny = dx / length;
    const bend = (14 + Math.random() * 42) * (Math.random() < 0.5 ? -1 : 1);
    const cx = (this.x + x) / 2 + nx * bend;
    const cy = (this.y + y) / 2 + ny * bend;
    const steps = Math.max(14, Math.min(42, Math.round(length / 16)));
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      const px = (1 - t) * (1 - t) * this.x + 2 * (1 - t) * t * cx + t * t * x;
      const py = (1 - t) * (1 - t) * this.y + 2 * (1 - t) * t * cy + t * t * y;
      await this.page.mouse.move(px, py);
      await this.show(px, py);
      await this.page.waitForTimeout((7 + Math.random() * 11) * this.pace);
    }
    this.x = x;
    this.y = y;
  }

  private async point(locator: Locator) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error("Nothing to point at");
    const x = box.x + box.width * (0.28 + Math.random() * 0.44);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);
    await this.move(x, y);
    await this.pause(110 + Math.random() * 160);
    return { x, y };
  }

  async hover(locator: Locator) {
    await this.point(locator);
  }

  async click(locator: Locator) {
    const { x, y } = await this.point(locator);
    await this.page.mouse.down();
    await this.pause(35 + Math.random() * 45);
    await this.page.mouse.up();
    await this.page.evaluate(
      ({ x, y }) => {
        const ripple = document.createElement("div");
        ripple.className = "sales-ripple";
        ripple.style.left = `${x}px`;
        ripple.style.top = `${y}px`;
        document.documentElement.append(ripple);
        ripple.animate(
          [
            { transform: "scale(0.35)", opacity: 0.75 },
            { transform: "scale(1.5)", opacity: 0 },
          ],
          { duration: 280, easing: "ease-out" },
        );
        setTimeout(() => ripple.remove(), 300);
      },
      { x, y },
    ).catch(() => undefined);
  }

  async typeInto(locator: Locator, text: string, clear = false) {
    await this.click(locator);
    if (clear) {
      await this.page.keyboard.press("Meta+A");
      await this.pause(80);
      await this.page.keyboard.press("Backspace");
      await this.pause(120);
    } else {
      await this.page.keyboard.press("End");
    }
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") await this.page.keyboard.press("Enter");
      else await this.page.keyboard.type(text[i]);
      let gap = 36 + Math.random() * 55;
      if (text[i] === " " || text[i] === "\n") gap += 70;
      if (i > 0 && i % 14 === 0) gap += 120;
      await this.pause(gap);
    }
  }

  async stroke(locator: Locator, points: { x: number; y: number }[]) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box || points.length < 2) throw new Error("Nothing to draw on");
    const at = (point: { x: number; y: number }) => ({
      x: box.x + point.x * box.width,
      y: box.y + point.y * box.height,
    });
    const start = at(points[0]);
    await this.move(start.x, start.y);
    await this.pause(80);
    await this.page.mouse.down();
    for (const point of points.slice(1)) {
      const next = at(point);
      await this.move(next.x, next.y);
    }
    await this.pause(60);
    await this.page.mouse.up();
  }
}
