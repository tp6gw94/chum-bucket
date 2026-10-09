import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import chat, { compact } from "./chat";
import thread from "./thread";
import sideChat from "./side-chat";
import { launchChatRuntime, shutdownChatRuntime } from "./harness/run";

const app = new Hono();
app.get("/", (c) => c.text("Hello Node.js!"));
app.route("/api/chat", chat);
app.route("/api/compact", compact);
app.route("/api/thread", thread);
app.route("/api/side-chat", sideChat);

await launchChatRuntime();
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
let stopping = false;
async function shutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  server.close();
  if ("closeAllConnections" in server) {
    server.closeAllConnections();
  }
  await shutdownChatRuntime();
}
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
