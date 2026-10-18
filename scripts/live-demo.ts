import { unlinkSync } from "node:fs";
import { mux } from "./live-mux.ts";
import { generateVoice } from "./live-voice.ts";
import { recordWalk } from "./live-walk.ts";

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
