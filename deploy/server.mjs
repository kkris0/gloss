import { createServer } from "node:http";
import { lstat, rm } from "node:fs/promises";
import next from "next";

const originSocket = process.env.GLOSS_ORIGIN_SOCKET ?? "/run/gloss/origin.sock";
const app = next({ dev: false, dir: process.cwd() });
const handle = app.getRequestHandler();

await app.prepare();

try {
  const existing = await lstat(originSocket);
  if (!existing.isSocket()) {
    throw new Error(`refusing to replace non-socket origin path: ${originSocket}`);
  }
  await rm(originSocket);
} catch (error) {
  if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
}

const server = createServer((request, response) => handle(request, response));

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(originSocket, () => {
    server.off("error", reject);
    resolve();
  });
});

server.on("error", (error) => {
  console.error("Next origin server error", error);
  process.exit(1);
});

console.log(`Next origin listening on Unix socket ${originSocket}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;

  const forcedExit = setTimeout(() => process.exit(1), 10_000);
  forcedExit.unref();

  await new Promise((resolve) => server.close(resolve));
  await app.close();
  await rm(originSocket, { force: true });
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    close().catch((error) => {
      console.error("Failed to close the Next origin cleanly", error);
      process.exitCode = 1;
    });
  });
}
