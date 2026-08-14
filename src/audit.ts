import { db } from "./db.js";

const insertStmt = db.prepare(`
  INSERT INTO audit_log (actor, event, entity_type, entity_id, metadata)
  VALUES (@actor, @event, @entity_type, @entity_id, @metadata)
`);

export function audit(
  actor: string,
  event: string,
  entity?: { type: string; id: string },
  metadata?: Record<string, unknown>,
): void {
  insertStmt.run({
    actor,
    event,
    entity_type: entity?.type ?? null,
    entity_id: entity?.id ?? null,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
}
