import { randomBytes } from "node:crypto";
import { db } from "./db.js";
import { audit } from "./audit.js";
import type { Tier } from "./config.js";

export interface Order {
  id: string;
  lead_id: number;
  tier: Exclude<Tier, "trial">;
  amount_usd: number;
  status: "pending" | "paid" | "failed" | "refunded";
  external_ref?: string;
}

const insertStmt = db.prepare(`
  INSERT INTO orders (id, lead_id, tier, amount_usd, external_ref)
  VALUES (@id, @lead_id, @tier, @amount_usd, @external_ref)
`);
const markPaidStmt = db.prepare(`UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?`);
const markRefundedStmt = db.prepare(`UPDATE orders SET status = 'refunded' WHERE external_ref = ?`);
const findByRefStmt = db.prepare(`SELECT * FROM orders WHERE external_ref = ?`);
const findByIdStmt = db.prepare(`SELECT * FROM orders WHERE id = ?`);

export function createOrder(leadId: number, tier: Exclude<Tier, "trial">, amountUsd: number): string {
  const id = "ord_" + randomBytes(6).toString("hex");
  insertStmt.run({ id, lead_id: leadId, tier, amount_usd: amountUsd, external_ref: null });
  audit("system", "order.created", { type: "order", id }, { leadId, tier, amountUsd });
  return id;
}

export function attachExternalRef(orderId: string, ref: string): void {
  db.prepare(`UPDATE orders SET external_ref = ? WHERE id = ?`).run(ref, orderId);
}

export function markOrderPaid(orderId: string): void {
  markPaidStmt.run(orderId);
  audit("system", "order.paid", { type: "order", id: orderId });
}

export function markOrderRefunded(externalRef: string): Order | undefined {
  markRefundedStmt.run(externalRef);
  const order = findByRefStmt.get(externalRef) as Order | undefined;
  if (order) audit("system", "order.refunded", { type: "order", id: order.id }, { externalRef });
  return order;
}

export function getOrderByExternalRef(ref: string): Order | undefined {
  return findByRefStmt.get(ref) as Order | undefined;
}

export function getOrderById(id: string): Order | undefined {
  return findByIdStmt.get(id) as Order | undefined;
}
