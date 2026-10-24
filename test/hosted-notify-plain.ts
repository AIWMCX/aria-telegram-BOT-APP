import assert from "node:assert/strict";
import { toPlainHostedText, formatHostedStatusMessage } from "../src/fleet/hosted-commands.js";

// The real failing reply: an underscore in a command name broke Telegram's Markdown parser.
const reply = "✅ Started — this runs on ARIA's infrastructure, no local process needed. Use /paper_status to check progress.";
assert.equal(toPlainHostedText(reply), reply, "command names with underscores are kept verbatim");
const status = formatHostedStatusMessage(undefined, { desiredRunning: false });
const plain = toPlainHostedText(status);
assert.ok(!plain.includes("*"), "bold markers are stripped from the status message");
assert.ok(plain.includes("Hosted PAPER status"), "status text survives");
console.log("hosted notify plain text: ok");
