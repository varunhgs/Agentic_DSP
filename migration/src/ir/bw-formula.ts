import { type Expr, func, val } from './expr.js';

/**
 * Translator for the BW transformation formula language (StepFormula `formula` attribute).
 *
 * Deliberately a small subset: field references, string and number literals, + - * /,
 * comparisons, AND / OR / NOT, IF, LEFT, RIGHT and CONCATENATE. Any other function or
 * syntax raises FormulaError — the rule is then reported as unsupported, never approximated.
 *
 * Argument order of LEFT/RIGHT: BW writes the length first, as in the formula observed on the
 * system, `RIGHT ( 8 , SALES_ORG )`. SQL takes the string first, so the arguments are swapped.
 * Only RIGHT has been observed; LEFT is assumed to follow the same convention (see `notes`).
 */

export class FormulaError extends Error {}

export interface FormulaResult {
  expr: Expr;
  /** Semantic points a reviewer must confirm before the translation is trusted. */
  notes: string[];
}

type Tok = { t: 'id' | 'num' | 'str' | 'op' | '(' | ')' | ','; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let j = i + 1, s = '';
      for (;;) {
        if (j >= src.length) throw new FormulaError('unterminated string literal');
        if (src[j] === "'" && src[j + 1] === "'") { s += "'"; j += 2; continue; }
        if (src[j] === "'") break;
        s += src[j++];
      }
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<>', '<=', '>='].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('=<>+-*/'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if (c === '(' || c === ')' || c === ',') { out.push({ t: c, v: c }); i++; continue; }
    const num = src.slice(i).match(/^\d+(\.\d+)?/);
    if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
    const id = src.slice(i).match(/^[A-Za-z_$/][A-Za-z0-9_$/]*/);
    if (id) { out.push({ t: 'id', v: id[0].toUpperCase() }); i += id[0].length; continue; }
    throw new FormulaError(`unexpected character "${c}"`);
  }
  return out;
}

/**
 * @param formula   the BW formula text
 * @param columnOf  maps a BW source field named in the formula to its source column; returns
 *                  undefined for a name that is not a source field of the rule
 */
export function translateBwFormula(formula: string, columnOf: (field: string) => string | undefined): FormulaResult {
  const toks = tokenize(formula);
  const notes = new Set<string>();
  let p = 0;
  const peek = () => toks[p];
  const take = (t?: Tok['t'], v?: string): Tok => {
    const k = toks[p];
    if (!k || (t && k.t !== t) || (v && k.v !== v)) throw new FormulaError(`expected ${v ?? t} at token ${p + 1}, found ${k ? k.v : 'end of formula'}`);
    p++;
    return k;
  };
  const isKw = (v: string) => peek()?.t === 'id' && peek().v === v;

  const orExpr = (): Expr => {
    const args = [andExpr()];
    while (isKw('OR')) { p++; args.push(andExpr()); }
    return args.length > 1 ? { k: 'logic', op: 'or', args } : args[0];
  };
  const andExpr = (): Expr => {
    const args = [notExpr()];
    while (isKw('AND')) { p++; args.push(notExpr()); }
    return args.length > 1 ? { k: 'logic', op: 'and', args } : args[0];
  };
  const notExpr = (): Expr => {
    if (isKw('NOT')) { p++; return { k: 'not', arg: notExpr() }; }
    return cmpExpr();
  };
  const cmpExpr = (): Expr => {
    const left = addExpr();
    const k = peek();
    if (k?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(k.v)) {
      p++;
      notes.add('BW compares CHAR values ignoring trailing blanks; confirm the loaded Datasphere values carry no trailing blanks');
      return { k: 'cmp', op: k.v as any, left, right: addExpr() };
    }
    return left;
  };
  const addExpr = (): Expr => {
    let e = mulExpr();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = take().v as '+' | '-';
      e = { k: 'binop', op, left: e, right: mulExpr() };
    }
    return e;
  };
  const mulExpr = (): Expr => {
    let e = primary();
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = take().v as '*' | '/';
      if (op === '/') notes.add('Division: BW decimal rounding and division by zero (BW: result 0 / error record) differ from SQL; verify with real data');
      e = { k: 'binop', op, left: e, right: primary() };
    }
    return e;
  };
  const args = (): Expr[] => {
    take('(');
    const list = [orExpr()];
    while (peek()?.t === ',') { p++; list.push(orExpr()); }
    take(')');
    return list;
  };
  const primary = (): Expr => {
    const k = peek();
    if (!k) throw new FormulaError('unexpected end of formula');
    if (k.t === '(') { p++; const e = orExpr(); take(')'); return e; }
    if (k.t === 'str') { p++; return val(k.v); }
    if (k.t === 'num') { p++; return val(Number(k.v)); }
    if (k.t === 'op' && k.v === '-') { p++; return { k: 'binop', op: '-', left: val(0), right: primary() }; }
    if (k.t === 'id') {
      p++;
      if (peek()?.t === '(') {
        const a = args();
        switch (k.v) {
          case 'IF':
            if (a.length !== 3) throw new FormulaError('IF takes 3 arguments');
            return { k: 'case', when: [{ cond: a[0], then: a[1] }], else: a[2] };
          case 'LEFT':
          case 'RIGHT':
            if (a.length !== 2) throw new FormulaError(`${k.v} takes 2 arguments`);
            notes.add(`${k.v}: BW argument order (length, string) assumed from the observed formula RIGHT ( 8 , SALES_ORG ); confirm in the BW formula editor`);
            return func(k.v, a[1], a[0]);
          case 'CONCATENATE':
            if (a.length < 2) throw new FormulaError('CONCATENATE takes at least 2 arguments');
            notes.add('CONCATENATE: BW drops trailing blanks of CHAR operands; SQL || keeps them');
            return a.slice(1).reduce((l, r) => ({ k: 'binop', op: '||', left: l, right: r }), a[0]);
          default:
            throw new FormulaError(`function ${k.v} is not supported by the translator`);
        }
      }
      const column = columnOf(k.v);
      if (!column) throw new FormulaError(`field ${k.v} is not a source field of this rule`);
      return { k: 'ref', column };
    }
    throw new FormulaError(`unexpected token ${k.v}`);
  };

  const expr = orExpr();
  if (p < toks.length) throw new FormulaError(`unexpected token ${toks[p].v} after the end of the expression`);
  return { expr, notes: [...notes] };
}
