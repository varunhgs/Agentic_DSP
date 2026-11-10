import type { TransformationIR } from '../ir/transformation-ir.js';
import { toSql } from '../ir/expr.js';
import { type FlowResult, SOURCE_ALIAS, columnExpr } from '../converters/trfn-to-transformation-flow.js';
import type { ValidationResult } from '../validate/local-table.js';

/** Human-readable mapping report: one row per target column, then every diagnostic. */
export function renderMappingReport(ir: TransformationIR, flow: FlowResult, validation: ValidationResult): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines: string[] = [];
  lines.push(`# Transformation ${ir.transformation} → ${flow.flowName} (dry run)`, '');
  lines.push(`- BW: ${ir.source.bwType} ${ir.source.bwName} → ${ir.target.bwType} ${ir.target.bwName}, ${ir.runtime} runtime`);
  lines.push(`- Datasphere: ${ir.source.table} → transformation flow ${flow.flowName} → ${ir.target.table}`);
  lines.push(`- Aggregation: ${ir.aggregation.collapses ? 'rows collapse — GROUP BY target key' : 'one row per source row'} (${ir.aggregation.reason})`);
  lines.push(`- Creation order: ${ir.creationOrder.join(' → ') || '(unresolved)'}`);
  lines.push(`- Deployable as proposed: **${flow.deployable ? 'yes' : 'no'}** · offline validation: **${validation.ok ? 'passed' : 'failed'}**`);
  lines.push('', '## Rules', '', '| Rule | BW target | Kind | Status | Datasphere expression | Notes |', '|---|---|---|---|---|---|');
  for (const m of ir.mappings) {
    const e = m.expr ? `\`${esc(toSql(columnExpr(m), SOURCE_ALIAS))}\`` : '—';
    const errs = ir.diagnostics.filter((d) => d.severity === 'error' && (d.field === m.bwTarget || (d.ruleId && d.ruleId === m.trace.ruleId))).map((d) => `${d.code}: ${d.message}`);
    const src = m.trace.bwFormula ? `BW formula \`${esc(m.trace.bwFormula.trim())}\`. ` : m.trace.bwConstant !== undefined ? `BW constant '${esc(m.trace.bwConstant)}'. ` : '';
    lines.push(`| ${m.trace.ruleId ?? '—'} | ${m.bwTarget} | ${m.kind} | ${m.status} | ${e} | ${esc(src + [...m.notes, ...errs].join('; '))} |`);
  }
  lines.push('', '## Diagnostics', '');
  if (!ir.diagnostics.length) lines.push('(none)');
  for (const d of ir.diagnostics) lines.push(`- **${d.severity}** ${d.code}${d.ruleId ? ` (rule ${d.ruleId})` : ''}${d.field ? ` [${d.field}]` : ''}: ${d.message}`);
  lines.push('', '## Offline validation', '');
  for (const c of validation.checks) lines.push(`- ${c.ok ? '✔' : '✘'} ${c.name}${c.detail ? ` — ${esc(c.detail)}` : ''}`);
  lines.push('', '## Not established by this dry run', '');
  lines.push('- That Datasphere accepts and deploys the document (no live call was made).');
  lines.push('- That the flow computes the same data as BW (needs data in both systems and a reconciliation).');
  lines.push('- `groupBy` in the CQN follows the CDS query notation; the reference flow on the tenant has no GROUP BY, so this part of the shape is not confirmed by the tenant.');
  lines.push('- `truncate: true` (full reload) is a value choice; the reference flows use `false`.');
  return lines.join('\n') + '\n';
}
