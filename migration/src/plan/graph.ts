/**
 * Dependency ordering for migration objects. Kahn's algorithm with a stable order (input order
 * among ready nodes), so the same input always yields the same plan; a cycle is reported with
 * its members instead of being executed. Used for one transformation now, and meant for whole
 * multi-layer flows later (aDSO tables → flows → task chains).
 */

export interface GraphNode {
  id: string;
  dependsOn: string[];
}

export type TopoResult = { ok: true; order: string[] } | { ok: false; cycle: string[]; missing: string[] };

export function topoSort(nodes: GraphNode[]): TopoResult {
  const ids = new Set(nodes.map((n) => n.id));
  const missing = [...new Set(nodes.flatMap((n) => n.dependsOn.filter((d) => !ids.has(d))))];
  if (missing.length) return { ok: false, cycle: [], missing };

  const remaining = new Map(nodes.map((n) => [n.id, new Set(n.dependsOn)]));
  const order: string[] = [];
  while (remaining.size) {
    const ready = nodes.map((n) => n.id).filter((id) => remaining.has(id) && remaining.get(id)!.size === 0);
    if (!ready.length) return { ok: false, cycle: [...remaining.keys()], missing: [] };
    for (const id of ready) {
      remaining.delete(id);
      order.push(id);
      for (const deps of remaining.values()) deps.delete(id);
    }
  }
  return { ok: true, order };
}
