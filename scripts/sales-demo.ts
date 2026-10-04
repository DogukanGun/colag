import { unlinkSync } from "node:fs";
import { mux } from "./sales-mux.ts";
import { generateVoice } from "./sales-voice.ts";
import { recordWalk } from "./sales-walk.ts";

const takes = await (async () => {
  await generateVoice();
  return recordWalk();
})();
mux(takes);
try {
  unlinkSync("/tmp/colag-xai.key");
} catch {
  /* the key may already live only in the environment */
}
