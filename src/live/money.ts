/**
 * LIVE 0.1 — the quoted/realized money boundary.
 *
 * WHY THIS FILE EXISTS. Milestone 1 does not reach real submission, but
 * the types built now decide what a later author can accidentally do. The
 * two mistakes this file makes structurally impossible are:
 *
 *   1. Treating an ESTIMATED or QUOTED amount as a REAL, reconciled one.
 *      A quote is what a route provider said would probably happen. A
 *      realized amount is what a landed transaction actually did. As plain
 *      `bigint`s they are indistinguishable — which is exactly why a plain
 *      `bigint` is not safe enough for money in this codebase.
 *
 *   2. Minting a "realized" amount out of nothing. `realizedLamports`
 *      REQUIRES landed-transaction evidence, and carries that evidence
 *      with it forever. There is no way to produce one from a quote, a
 *      preview, a mark or an expectation without fabricating a signature
 *      and a slot — a deliberate act, not a slip.
 *
 * The distinction is deliberately a WRAPPER OBJECT rather than a
 * TypeScript-only branded `bigint`. A branded primitive vanishes at
 * runtime: it survives neither a JSON round trip nor a cast, so the
 * guarantee would hold only for code that compiles in this repo and would
 * quietly evaporate at every boundary that matters. A wrapper is
 * `typeof`-inspectable, survives serialization, and — because arithmetic
 * requires explicitly unwrapping `.lamports` — makes mixing the two kinds
 * something an author has to *choose* to write.
 *
 * All money is `bigint` lamports. No float ever touches money here, in the
 * schema, or anywhere downstream.
 */

/**
 * The only thing that licenses a realized amount: a signature and a slot,
 * together meaning "this happened, at this point in the chain's history".
 */
export interface LandedTransactionEvidence {
  readonly txSignature: string;
  readonly slot: number;
}

/** An estimate. From a quote, a preview, a curve, or a projection. Never from the chain. */
export interface QuotedLamports {
  readonly kind: "quoted";
  readonly lamports: bigint;
}

/** A fact. From a landed, parsed transaction and nowhere else. */
export interface RealizedLamports {
  readonly kind: "realized";
  readonly lamports: bigint;
  readonly evidence: LandedTransactionEvidence;
}

export function quotedLamports(value: bigint): QuotedLamports {
  if (typeof value !== "bigint") throw new TypeError("quotedLamports: lamports must be a bigint, never a number or a float");
  return Object.freeze({ kind: "quoted" as const, lamports: value });
}

/**
 * Throws rather than returning a sentinel or a zero. A caller who cannot
 * supply landed-transaction evidence does not have a realized amount, and
 * the correct behaviour is to stop — not to produce a plausible-looking
 * number that a report will later print as if it were money.
 */
export function realizedLamports(value: bigint, evidence: LandedTransactionEvidence): RealizedLamports {
  if (typeof value !== "bigint") throw new TypeError("realizedLamports: lamports must be a bigint, never a number or a float");
  if (!evidence || typeof evidence !== "object") {
    throw new TypeError("realizedLamports: landed-transaction evidence is required — a realized amount cannot be minted from an estimate");
  }
  if (typeof evidence.txSignature !== "string" || evidence.txSignature.length === 0) {
    throw new TypeError("realizedLamports: evidence.txSignature is required");
  }
  if (!Number.isInteger(evidence.slot) || evidence.slot <= 0) {
    throw new TypeError("realizedLamports: evidence.slot must be a positive integer slot");
  }
  return Object.freeze({
    kind: "realized" as const,
    lamports: value,
    evidence: Object.freeze({ txSignature: evidence.txSignature, slot: evidence.slot }),
  });
}

export function isQuoted(value: QuotedLamports | RealizedLamports): boolean {
  return value.kind === "quoted";
}

export function isRealized(value: QuotedLamports | RealizedLamports): boolean {
  return value.kind === "realized";
}

/**
 * The single place a realized amount is unwrapped for arithmetic or
 * persistence. Named so that a reviewer grepping for how a realized figure
 * became a bare bigint finds every site. There is deliberately no generic
 * `unwrap()` that accepts either kind — that function would be the exact
 * conflation this module exists to prevent.
 */
export function realizedValue(value: RealizedLamports): bigint {
  if (value.kind !== "realized") throw new TypeError("realizedValue: refused a non-realized amount");
  return value.lamports;
}

export function quotedValue(value: QuotedLamports): bigint {
  if (value.kind !== "quoted") throw new TypeError("quotedValue: refused a non-quoted amount");
  return value.lamports;
}
