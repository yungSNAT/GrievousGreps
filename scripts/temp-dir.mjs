/**
 * mkdtempSync with a lowercase hex suffix, for the test runner and the test fixtures.
 *
 * mkdtemp's suffix mixes upper case, lower case and digits, so a command that holds
 * the path (`cd "/tmp/trail-test-run-F2hE9S/..."`) can read as a long random string
 * to the secret check in src/notes/secrets.ts, and a run then records it with no
 * command. Hex has one case, so the suffix never adds to that.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";

/** A new folder at `prefix` plus 16 hex characters, private to the user as mkdtemp's is. */
export function mkdtempHex(prefix) {
  const dir = `${prefix}${randomBytes(8).toString("hex")}`;
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}
