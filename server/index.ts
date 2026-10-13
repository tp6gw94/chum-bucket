import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import chat from "./chat";
import thread from "./thread";
import { launchChatRuntime, shutdownChatRuntime } from "./harness/run";

const app = new Hono();
app.get("/", (c) => c.text("Hello Node.js!"));
app.route("/api/chat", chat);
app.route("/api/thread", thread);

await launchChatRuntime();
const server = serve(app);
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
