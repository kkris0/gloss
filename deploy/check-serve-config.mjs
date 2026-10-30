import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function assertBooleanMap(value, path) {
  if (typeof value === "boolean") {
    if (value) throw new Error(`Funnel is enabled at ${path}`);
    return;
  }

  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`unexpected AllowFunnel value at ${path}`);
  }

  for (const [key, child] of Object.entries(value)) {
    assertBooleanMap(child, `${path}.${key}`);
  }
}

function inspect(value, path = "ServeConfig") {
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((child, index) => inspect(child, `${path}[${index}]`));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "AllowFunnel") assertBooleanMap(child, `${path}.${key}`);
    inspect(child, `${path}.${key}`);
  }
}

export function assertNoFunnel(json) {
  let config;
  try {
    config = JSON.parse(json);
  } catch {
    throw new Error("Tailscale Serve status was not readable JSON");
  }

  if (config === null || Array.isArray(config) || typeof config !== "object") {
    throw new Error("Tailscale Serve status was not a JSON object");
  }

  inspect(config);
}

function main() {
  try {
    assertNoFunnel(readFileSync(0, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid Serve status";
    console.error(`Unsafe Tailscale Serve configuration: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
