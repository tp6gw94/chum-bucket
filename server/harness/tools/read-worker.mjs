import { parentPort, workerData } from "node:worker_threads";
import { createReadTool } from "@earendil-works/pi-coding-agent";

try {
  const result = await createReadTool(workerData.cwd).execute(workerData.id, workerData.input);
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : "Read failed" });
}
