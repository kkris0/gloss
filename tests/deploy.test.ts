import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const root = resolve(process.cwd());

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("Fly has no public service or Funnel and Serve targets the Unix origin", () => {
  const fly = source("deploy/fly.toml").replace(/^\s*#.*$/gm, "");
  const deployment = [
    source("deploy/entrypoint.sh"),
    source("deploy/supervisor.mjs"),
  ].join("\n");

  assert.doesNotMatch(fly, /^\s*\[http_service\]/m);
  assert.doesNotMatch(fly, /^\s*\[\[services(?:\.ports)?\]\]/m);
  assert.doesNotMatch(fly, /^\s*internal_port\s*=/m);
  assert.doesNotMatch(deployment, /tailscale\s+funnel/);
  assert.match(deployment, /"serve"[\s\S]*"--https=443"[\s\S]*originTarget/);
  assert.match(deployment, /"unix:\/run\/gloss\/origin\.sock"/);
});

test("the Next origin listens only on its Unix socket", () => {
  const server = source("deploy/server.mjs");

  assert.match(server, /listen\(originSocket(?:,|\))/);
  assert.doesNotMatch(server, /127\.0\.0\.1|0\.0\.0\.0|localhost/);
  assert.doesNotMatch(server, /\.listen\(\s*\d|\.listen\(\s*port/i);
});

test("Serve JSON guard accepts false and rejects true or unreadable state", async () => {
  const guardModule: { assertNoFunnel(json: string): void } = await import(
    pathToFileURL(join(root, "deploy/check-serve-config.mjs")).href
  );

  assert.doesNotThrow(() => guardModule.assertNoFunnel(JSON.stringify({
    AllowFunnel: { "gloss:443": false },
    Foreground: {
      foreground: { AllowFunnel: { "gloss:8443": false } },
    },
  })));

  assert.throws(() => guardModule.assertNoFunnel(
    JSON.stringify({ AllowFunnel: { "gloss:443": true } }),
  ));

  assert.throws(() => guardModule.assertNoFunnel(JSON.stringify({
    Foreground: {
      foreground: { AllowFunnel: { "gloss:443": true } },
    },
  })));

  assert.throws(() => guardModule.assertNoFunnel("not json"));
});

test("supervisor exits and terminates Next when tailscaled dies", async () => {
  const fixture = supervisionFixture("tailscaled");
  try {
    const result = await fixture.run();
    assert.notEqual(result, 0);
    assert.match(readFileSync(fixture.events, "utf8"), /app:TERM/);
  } finally {
    fixture.cleanup();
  }
});

test("supervisor exits and terminates tailscaled when Next dies", async () => {
  const fixture = supervisionFixture("app");
  try {
    const result = await fixture.run();
    assert.notEqual(result, 0);
    assert.match(readFileSync(fixture.events, "utf8"), /tailscaled:TERM/);
  } finally {
    fixture.cleanup();
  }
});

test("supervisor forwards TERM to both children and exits with the signal status", async () => {
  const fixture = supervisionFixture("neither");
  try {
    const result = await fixture.run(true);
    assert.equal(result, 143);
    const events = readFileSync(fixture.events, "utf8");
    assert.match(events, /app:TERM/);
    assert.match(events, /tailscaled:TERM/);
  } finally {
    fixture.cleanup();
  }
});

function supervisionFixture(whichDies: "tailscaled" | "app" | "neither") {
  const dir = mkdtempSync(join(tmpdir(), "gloss-deploy-test-"));
  const bin = join(dir, "bin");
  const events = join(dir, "events");
  const app = join(dir, "app.mjs");
  const tailscaled = join(bin, "tailscaled");
  const tailscale = join(bin, "tailscale");
  mkdirSync(bin);
  writeFileSync(events, "");
  writeFileSync(tailscale, `#!/bin/sh
if [ "$1" = "serve" ] && [ "$2" = "status" ]; then
  printf '%s\\n' '{"AllowFunnel":{"gloss:443":false}}'
fi
exit 0
`);
  writeFileSync(tailscaled, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.GLOSS_TEST_EVENTS, "tailscaled:start\\n");
process.on("SIGTERM", () => {
  fs.appendFileSync(process.env.GLOSS_TEST_EVENTS, "tailscaled:TERM\\n");
  process.exit(0);
});
${whichDies === "tailscaled" ? "setTimeout(() => process.exit(24), 100);" : "setInterval(() => {}, 1_000);"}
`);
  writeFileSync(app, `import { appendFileSync } from "node:fs";
appendFileSync(process.env.GLOSS_TEST_EVENTS, "app:start\\n");
process.on("SIGTERM", () => {
  appendFileSync(process.env.GLOSS_TEST_EVENTS, "app:TERM\\n");
  process.exit(0);
});
${whichDies === "app" ? "setTimeout(() => process.exit(23), 100);" : "setInterval(() => {}, 1_000);"}
`);
  chmodSync(tailscale, 0o755);
  chmodSync(tailscaled, 0o755);

  return {
    events,
    run: (signalSupervisor = false) => new Promise<number | null>((resolveRun, rejectRun) => {
      const child = spawn(
        process.execPath,
        [join(root, "deploy/supervisor.mjs"), app],
        {
          stdio: "ignore",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            GLOSS_TEST_EVENTS: events,
            GLOSS_TAILSCALE_STATE_DIR: join(dir, "state"),
            GLOSS_TAILSCALE_SOCKET_DIR: join(dir, "run-tailscale"),
            GLOSS_ORIGIN_DIR: join(dir, "run-gloss"),
            GLOSS_ORIGIN_SOCKET: join(dir, "run-gloss/origin.sock"),
          },
        },
      );
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        rejectRun(new Error("supervisor did not exit after a child died"));
      }, 5_000);
      const signalTimeout = signalSupervisor
        ? setTimeout(() => child.kill("SIGTERM"), 150)
        : undefined;
      child.once("error", rejectRun);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        clearTimeout(signalTimeout);
        resolveRun(code);
      });
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
