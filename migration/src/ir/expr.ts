/**
 * Target-neutral expression tree used by the transformation IR.
 *
 * One tree renders to both forms a Datasphere SQL view transform carries: the SQL text
 * (`@DataWarehouse.sqlEditor.query`) and the parsed CQN (`query`). Generating both from the
 * same tree keeps them consistent; the CQN shapes (`ref`, `val`, `func`/`args`, `xpr`, `as`)
 * are the ones seen in the tenant's own transformation flow Tf_adj_qty.
 */

export type ValueType = 'string' | 'date' | 'decimal' | 'integer' | 'boolean' | 'unknown';

export type Expr =
  | { k: 'ref'; column: string }
  | { k: 'val'; value: string | number }
  | { k: 'func'; name: string; args: Expr[] }
  | { k: 'binop'; op: '+' | '-' | '*' | '/' | '||'; left: Expr; right: Expr }
  | { k: 'cmp'; op: '=' | '<>' | '<' | '>' | '<=' | '>='; left: Expr; right: Expr }
  | { k: 'logic'; op: 'and' | 'or'; args: Expr[] }
  | { k: 'not'; arg: Expr }
  | { k: 'case'; when: Array<{ cond: Expr; then: Expr }>; else: Expr }
  /** Only the digits of a string (HANA REPLACE_REGEXPR), used for ABAP's CHAR → NUMC move. */
  | { k: 'digits'; arg: Expr };

/** Functions the generator may emit. Anything else is refused by the validator. */
export const ALLOWED_FUNCTIONS = new Set(['TO_VARCHAR', 'COALESCE', 'LEFT', 'RIGHT', 'SUBSTRING', 'LPAD', 'ISOWEEK', 'REPLACE', 'BINTOHEX', 'REPLACE_REGEXPR', 'SUM', 'MIN', 'MAX']);
export const AGGREGATE_FUNCTIONS = new Set(['SUM', 'MIN', 'MAX']);

export const ref = (column: string): Expr => ({ k: 'ref', column });
export const val = (value: string | number): Expr => ({ k: 'val', value });
export const func = (name: string, ...args: Expr[]): Expr => ({ k: 'func', name, args });

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const quoteString = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function toSql(e: Expr, alias: string): string {
  switch (e.k) {
    case 'ref':
      return `${alias}.${quoteIdent(e.column)}`;
    case 'val':
      return typeof e.value === 'number' ? String(e.value) : quoteString(e.value);
    case 'func':
      return `${e.name}(${e.args.map((a) => toSql(a, alias)).join(', ')})`;
    case 'binop':
    case 'cmp':
      return `(${toSql(e.left, alias)} ${e.op} ${toSql(e.right, alias)})`;
    case 'logic':
      return `(${e.args.map((a) => toSql(a, alias)).join(` ${e.op.toUpperCase()} `)})`;
    case 'not':
      return `NOT ${toSql(e.arg, alias)}`;
    case 'case':
      return `CASE ${e.when.map((w) => `WHEN ${toSql(w.cond, alias)} THEN ${toSql(w.then, alias)}`).join(' ')} ELSE ${toSql(e.else, alias)} END`;
    case 'digits':
      return `REPLACE_REGEXPR('[^0-9]' IN ${toSql(e.arg, alias)} WITH '' OCCURRENCE ALL)`;
  }
}

/** CQN token(s) for an expression. Operators are flattened into `xpr`, as Datasphere does. */
export function toCqn(e: Expr, alias: string): any {
  switch (e.k) {
    case 'ref':
      return { ref: [alias, e.column] };
    case 'val':
      return { val: e.value };
    case 'func':
      return { func: e.name, args: e.args.map((a) => toCqn(a, alias)) };
    case 'binop':
    case 'cmp':
      return { xpr: [toCqn(e.left, alias), e.op, toCqn(e.right, alias)] };
    case 'logic':
      return { xpr: e.args.flatMap((a, i) => (i ? [e.op, toCqn(a, alias)] : [toCqn(a, alias)])) };
    case 'not':
      return { xpr: ['not', toCqn(e.arg, alias)] };
    case 'case':
      return {
        xpr: ['case', ...e.when.flatMap((w) => ['when', toCqn(w.cond, alias), 'then', toCqn(w.then, alias)]), 'else', toCqn(e.else, alias), 'end'],
      };
    case 'digits':
      return { func: 'REPLACE_REGEXPR', args: [{ xpr: [{ val: '[^0-9]' }, 'in', toCqn(e.arg, alias), 'with', { val: '' }, 'occurrence', 'all'] }] };
  }
}

/** Every column an expression reads. */
export function refsOf(e: Expr): string[] {
  switch (e.k) {
    case 'ref':
      return [e.column];
    case 'val':
      return [];
    case 'func':
      return e.args.flatMap(refsOf);
    case 'binop':
    case 'cmp':
      return [...refsOf(e.left), ...refsOf(e.right)];
    case 'logic':
      return e.args.flatMap(refsOf);
    case 'not':
    case 'digits':
      return refsOf(e.arg);
    case 'case':
      return [...e.when.flatMap((w) => [...refsOf(w.cond), ...refsOf(w.then)]), ...refsOf(e.else)];
  }
}

export function functionsOf(e: Expr): string[] {
  switch (e.k) {
    case 'func':
      return [e.name, ...e.args.flatMap(functionsOf)];
    case 'binop':
    case 'cmp':
      return [...functionsOf(e.left), ...functionsOf(e.right)];
    case 'logic':
      return e.args.flatMap(functionsOf);
    case 'not':
      return functionsOf(e.arg);
    case 'digits':
      return ['REPLACE_REGEXPR', ...functionsOf(e.arg)];
    case 'case':
      return [...e.when.flatMap((w) => [...functionsOf(w.cond), ...functionsOf(w.then)]), ...functionsOf(e.else)];
    default:
      return [];
  }
}

/** Result type of an expression, given the types of the columns it reads. */
export function typeOf(e: Expr, columnType: (c: string) => ValueType): ValueType {
  switch (e.k) {
    case 'ref':
      return columnType(e.column);
    case 'val':
      return typeof e.value === 'number' ? (Number.isInteger(e.value) ? 'integer' : 'decimal') : 'string';
    case 'func':
      if (['TO_VARCHAR', 'LEFT', 'RIGHT', 'SUBSTRING', 'LPAD', 'ISOWEEK', 'REPLACE', 'BINTOHEX'].includes(e.name)) return 'string';
      return e.args.length ? typeOf(e.args[0], columnType) : 'unknown';
    case 'binop':
      return e.op === '||' ? 'string' : typeOf(e.left, columnType);
    case 'cmp':
    case 'logic':
    case 'not':
      return 'boolean';
    case 'digits':
      return 'string';
    case 'case': {
      const types = new Set([...e.when.map((w) => typeOf(w.then, columnType)), typeOf(e.else, columnType)]);
      return types.size === 1 ? [...types][0] : 'unknown';
    }
  }
}
