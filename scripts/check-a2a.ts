import { ClientFactory } from "@a2a-js/sdk/client";
import { Message } from "@a2a-js/sdk";
const client = await new ClientFactory().createFromUrl("http://127.0.0.1:4320");
const result = await client.sendMessage({
  message: Message.fromJSON({
    messageId: crypto.randomUUID(),
    role: "ROLE_USER",
    parts: [{ text: "Review authentication requirements." }],
  }),
  metadata: undefined,
  configuration: undefined,
  tenant: "",
});
console.log(JSON.stringify(result, null, 2));
if (!("status" in result) || result.status?.state !== 3)
  throw new Error("A2A fixture did not complete");
