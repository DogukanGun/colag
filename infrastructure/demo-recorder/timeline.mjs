/**
 * Fits the voice-over to the footage (pure; unit-tested from tests/demo.test.ts).
 *
 * steps: [{ start, end }]  source seconds of each scripted step in the raw take
 * dead:  [[a, b]]          waits the recorder marked (page loads): cut, so shots change with hard cuts
 * clips: [{ step, duration }]  at most one voice line per step, spoken from the step's start
 *
 * A line starts at its step (after `leadIn`) or right after the previous line. When a line runs longer than its step,
 * the step's last frame is held until the voice is done; later steps move back by the same amount, so picture and voice
 * never drift. Every boundary sits on the frame grid, so the rendered pieces add up exactly.
 */
export function layout({ steps, dead = [], clips = [], total, fps = 30, leadIn = 0.2, gap = 0.3, tail = 0.35, margin = 0.05 }) {
  const frame = (t) => Math.round(t * fps) / fps;
  const cuts = mergeRanges(
    dead.map(([a, b]) => [a + margin, b - margin]).filter(([a, b]) => b - a > 0.2),
  ).map(([a, b]) => [frame(a), frame(b)]);
  const mapT = (t) => {
    let out = t;
    for (const [a, b] of cuts) {
      if (t <= a) break;
      out -= Math.min(t, b) - a;
    }
    return out;
  };
  const byStep = new Map(clips.map((c) => [c.step, c]));
  const holds = new Array(steps.length).fill(0);
  const lines = [];
  let shift = 0;
  let prevEnd = -Infinity;
  steps.forEach((step, i) => {
    const clip = byStep.get(i);
    if (clip) {
      const start = frame(Math.max(prevEnd + gap, mapT(step.start) + shift + leadIn));
      const end = start + clip.duration;
      const stepEnd = mapT(step.end) + shift;
      holds[i] = frame(Math.max(0, end + tail - stepEnd));
      shift += holds[i];
      lines.push({ step: i, start, duration: clip.duration });
      prevEnd = end;
    }
  });

  // the pieces of the raw take to keep, with the hold after each step's last piece
  const pieces = [];
  const keep = (from, to, hold = 0) => {
    const parts = subtract([frame(from), frame(to)], cuts);
    if (!parts.length) {
      if (hold > 0 && pieces.length) pieces[pieces.length - 1].hold += hold;
      return;
    }
    parts.forEach(([a, b], k) => pieces.push({ from: a, to: b, hold: k === parts.length - 1 ? hold : 0 }));
  };
  if (steps.length && steps[0].start > 0) keep(0, steps[0].start);
  steps.forEach((step, i) => keep(step.start, i + 1 < steps.length ? steps[i + 1].start : step.end, holds[i]));
  const last = steps.at(-1);
  if (last && total > last.end) keep(last.end, total);
  const length = pieces.reduce((n, p) => n + (p.to - p.from) + p.hold, 0);
  return { pieces: pieces.filter((p) => p.to - p.from > 0 || p.hold > 0), lines, length: frame(length), cuts };
}

export function mergeRanges(ranges) {
  const sorted = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const prev = out.at(-1);
    if (prev && a <= prev[1]) prev[1] = Math.max(prev[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** [from, to] minus the cut ranges. */
export function subtract([from, to], cuts) {
  const out = [];
  let t = from;
  for (const [a, b] of cuts) {
    if (b <= t || a >= to) continue;
    if (a > t) out.push([t, a]);
    t = Math.max(t, b);
  }
  if (t < to) out.push([t, to]);
  return out.filter(([a, b]) => b - a > 1e-6);
}

export function srtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}

export function srt(lines) {
  return lines.map((l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.start + l.duration)}\n${l.text}\n`).join("\n");
}
