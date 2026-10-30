// Makes the value for GLOSS_OWNER_PASSWORD_HASH: `npm run auth:hash`.
// Reads the password from the terminal without echoing it (or from stdin when piped), prints one line.
// The format matches lib/server/auth.ts: scrypt$N$r$p$salt$hash, base64url, NFKC-normalised password.
import { randomBytes, scryptSync } from "node:crypto";

const N = 2 ** 17;
const r = 8;
const p = 1;
const MIN = 12;

async function readPassword() {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.replace(/\r?\n$/, "");
  }
  process.stderr.write("Password (not shown): ");
  return await new Promise((resolve) => {
    let pw = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function onData(ch) {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(pw);
        }
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f") pw = pw.slice(0, -1);
        else pw += c;
      }
    });
  });
}

const password = await readPassword();
if ([...password].length < MIN) {
  console.error(`Use at least ${MIN} characters.`);
  process.exit(1);
}
const salt = randomBytes(16);
const key = scryptSync(password.normalize("NFKC"), salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 });
console.log(["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$"));
