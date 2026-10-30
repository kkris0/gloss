import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertNoFunnel } from "./check-serve-config.mjs";

const stateDir = process.env.GLOSS_TAILSCALE_STATE_DIR ?? "/data/tailscale";
const tailscaleSocketDir = process.env.GLOSS_TAILSCALE_SOCKET_DIR ?? "/var/run/tailscale";
const originDir = process.env.GLOSS_ORIGIN_DIR ?? "/run/gloss";
const originSocket = process.env.GLOSS_ORIGIN_SOCKET ?? "/run/gloss/origin.sock";
const originTarget = process.env.GLOSS_ORIGIN_SOCKET
  ? `unix:${originSocket}`
  : "unix:/run/gloss/origin.sock";
const serverFile = process.argv[2] ?? fileURLToPath(new URL("./server.mjs", import.meta.url));

await Promise.all([
  mkdir(stateDir, { recursive: true, mode: 0o700 }),
  mkdir(tailscaleSocketDir, { recursive: true, mode: 0o700 }),
  mkdir(originDir, { recursive: true, mode: 0o700 }),
]);

const abortController = new AbortController();
const managed = [];
let stopping = false;
let resolveOutcome;
const outcome = new Promise((resolve) => {
  resolveOutcome = resolve;
});

function reportOutcome(result) {
  if (stopping) return;
  resolveOutcome(result);
  abortController.abort();
}

function startManaged(name, command, args, options = {}) {
  const child = spawn(command, args, {
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });
  managed.push({ name, child });
  child.once("error", (error) => reportOutcome({ kind: "child", name, error }));
  child.once("exit", (code, signal) => {
    reportOutcome({ kind: "child", name, code, signal });
  });
  return child;
}

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      signal: abortController.signal,
      stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"],
    });
    const chunks = [];
    let bytes = 0;

    child.stdout?.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        child.kill("SIGTERM");
        reject(new Error(`${command} returned too much output`));
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    abortController.signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("startup aborted"));
    }, { once: true });
  });
}

async function configureTailscale() {
  const upArgs = [
    "up",
    `--hostname=${process.env.TS_HOSTNAME ?? "gloss"}`,
    "--accept-dns=false",
  ];
  if (process.env.TS_AUTHKEY) upArgs.push(`--authkey=${process.env.TS_AUTHKEY}`);

  let connected = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await run("tailscale", upArgs);
    if (result.code === 0) {
      connected = true;
      break;
    }
    await delay(1_000);
  }
  if (!connected) throw new Error("tailscale did not come up");

  const serve = await run("tailscale", [
    "serve",
    "--bg",
    "--yes",
    "--https=443",
    originTarget,
  ]);
  if (serve.code !== 0) throw new Error("tailscale serve failed");

  const status = await run("tailscale", ["serve", "status", "--json"], { capture: true });
  if (status.code !== 0) throw new Error("tailscale serve status failed");
  assertNoFunnel(status.stdout);
}

async function stopChildren() {
  stopping = true;
  abortController.abort();

  for (const { child } of managed) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }

  const settled = Promise.all(managed.map(({ child }) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", resolve);
  })));

  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(resolve, 10_000, "timeout");
  });
  const stopResult = await Promise.race([settled, timeout]);
  clearTimeout(timeoutId);
  if (stopResult === "timeout") {
    for (const { child } of managed) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await settled;
  }
}

for (const [signal, exitCode] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  process.on(signal, () => reportOutcome({ kind: "signal", signal, exitCode }));
}

startManaged("tailscaled", "tailscaled", [
  `--state=${stateDir}/tailscaled.state`,
  `--socket=${tailscaleSocketDir}/tailscaled.sock`,
  "--tun=userspace-networking",
]);
startManaged("Next", process.execPath, [serverFile], {
  env: { GLOSS_ORIGIN_SOCKET: originSocket },
});

const configured = configureTailscale().then(
  () => ({ kind: "configured" }),
  (error) => ({ kind: "configuration", error }),
);
const startup = await Promise.race([outcome, configured]);
const result = startup.kind === "configured" ? await outcome : startup;

if (result.kind === "child") {
  const detail = result.signal ?? result.code ?? result.error?.message ?? "unknown status";
  console.error(`${result.name} exited unexpectedly (${detail})`);
} else if (result.kind === "configuration") {
  console.error(`Deployment startup failed: ${result.error.message}`);
}

await stopChildren();
process.exitCode = result.kind === "signal" ? result.exitCode : 1;
