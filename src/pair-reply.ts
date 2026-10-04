/**
 * Pure formatter for the /pair Telegram reply (sent with legacy
 * `parse_mode: "Markdown"`).
 *
 * The code is deliberately NOT passed through bot.ts's `esc()`: that helper
 * escapes for MarkdownV2, but every reply in the bot uses legacy Markdown, where
 * escaping inside an entity (a `code` span) is not allowed (Telegram docs). A
 * code containing `_` or `-` (about 58% of 27-char base64url codes) would then
 * be shown with literal backslashes (`abc\_def\-ghi`) and fail when pasted into
 * `aria pair`. Inside a code span `_` and `-` are literal, so no escaping is
 * needed — and the alphabet check below guarantees nothing that could close the
 * span (a backtick) or start an escape (a backslash) can ever be present.
 */
const PAIRING_CODE_SHAPE = /^[A-Za-z0-9_-]{8,128}$/;

export function formatPairReply(code: string, expiresLabel: string): string {
  if (!PAIRING_CODE_SHAPE.test(code)) {
    throw new Error("unexpected pairing code format");
  }
  return [
    `*Pair your ARIA device*`, ``,
    `Run this on the computer running ARIA:`, ``,
    `\`aria pair ${code}\``, ``,
    `Expires ${expiresLabel} UTC (10 minutes) — single use. Run \`/pair\` again if it expires.`,
  ].join("\n");
}
