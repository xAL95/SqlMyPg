/**
 * PostgreSQL statement splitter and classifier.
 *
 * Hand-rolled lexer, not regexes: the executor reports a Postgres error position as an
 * editor marker, so it needs the exact character offset of every statement, and no regex
 * can see nested block comments or dollar-quoted bodies.
 */

export type SqlStatement = {
  /** trimmed statement text, without the trailing semicolon */
  sql: string;
  /** index of the first character of `sql` in the original script */
  offset: number;
  firstWord: string;
  returnsRows: boolean;
  simpleOnly: boolean;
};

/** `value` is the upper-cased text for 'word' and '' otherwise; `depth` is paren nesting. */
type Token = { kind: 'word' | 'other' | 'semi'; value: string; start: number; depth: number };

/** Identifier start: letter, underscore, or any non-ASCII character - Postgres allows those. */
const isWordStart = (c: string): boolean => {
  const n = c.charCodeAt(0);
  return (n >= 65 && n <= 90) || (n >= 97 && n <= 122) || n === 95 || n >= 128;
};
const isDigit = (c: string): boolean => c >= '0' && c <= '9';
/** Identifiers may contain a dollar sign, which is why foo$$x$$ is one identifier, not a quote. */
const isWordCont = (c: string): boolean => isWordStart(c) || isDigit(c) || c === '$';
const isTagChar = (c: string): boolean => isWordStart(c) || isDigit(c);

/** `i` is at the opening quote. Returns the index just past the closing quote, or EOF. */
function endOfQuoted(s: string, i: number, quote: string, backslash: boolean): number {
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (backslash && c === '\\') {
      j++; // escaped char, whatever it is
      continue;
    }
    if (c !== quote) continue;
    if (s[j + 1] === quote) {
      j++; // a doubled quote is one literal quote, the string continues
      continue;
    }
    return j + 1;
  }
  return s.length;
}

/** `i` is at the slash of a block comment opener. Block comments nest in Postgres. Returns -1 when unterminated. */
function endOfBlockComment(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '/' && s[j + 1] === '*') {
      depth++;
      j++;
    } else if (s[j] === '*' && s[j + 1] === '/') {
      depth--;
      j++;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

/** `i` is at a dollar sign. Returns -1 when this is not a dollar quote (e.g. the `$1` of a param). */
function endOfDollarQuoted(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length && isTagChar(s[j]!)) j++;
  if (s[j] !== '$') return -1;
  const tag = s.slice(i, j + 1); // '$$' or '$body$' - must match exactly to close
  const end = s.indexOf(tag, j + 1);
  return end < 0 ? s.length : end + tag.length;
}

const tok = (kind: Token['kind'], start: number, depth: number, value = ''): Token => ({
  kind,
  value,
  start,
  depth,
});

/**
 * Whitespace and comments yield no tokens, so "no tokens" means "nothing to run".
 * Strings, quoted identifiers and dollar-quoted bodies collapse into a single 'other'
 * token: their contents must never be read as keywords or statement ends.
 *
 * ponytail: a `BEGIN ATOMIC ... END` function body (PG14 SQL-standard bodies) still splits
 * on its inner semicolons, upgrade = track BEGIN ATOMIC/END nesting in this loop.
 */
function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let depth = 0;
  for (let i = 0; i < s.length; ) {
    const c = s[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      i++;
    } else if (c === '-' && s[i + 1] === '-') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl + 1;
    } else if (c === '/' && s[i + 1] === '*') {
      const end = endOfBlockComment(s, i);
      if (end < 0) {
        out.push(tok('other', i, depth)); // unterminated: keep the text, Postgres reports it
        i = s.length;
      } else {
        i = end;
      }
    } else if (c === "'" || c === '"') {
      out.push(tok('other', i, depth));
      i = endOfQuoted(s, i, c, false);
    } else if (c === '$') {
      const end = endOfDollarQuoted(s, i);
      out.push(tok('other', i, depth));
      i = end < 0 ? i + 1 : end;
    } else if (isWordStart(c)) {
      let j = i + 1;
      while (j < s.length && isWordCont(s[j]!)) j++;
      const value = s.slice(i, j).toUpperCase();
      // E'..' and U&'..' honour backslash escapes; B'..'/X'..' are plain strings.
      if (value === 'E' && s[j] === "'") {
        out.push(tok('other', i, depth));
        i = endOfQuoted(s, j, "'", true);
      } else if (value === 'U' && s[j] === '&' && s[j + 1] === "'") {
        out.push(tok('other', i, depth));
        i = endOfQuoted(s, j + 1, "'", true);
      } else {
        out.push(tok('word', i, depth, value));
        i = j;
      }
    } else if (c === '(') {
      out.push(tok('other', i, depth));
      depth++;
      i++;
    } else if (c === ')') {
      if (depth > 0) depth--;
      out.push(tok('other', i, depth));
      i++;
    } else if (c === ';') {
      out.push(tok('semi', i, depth));
      i++;
    } else {
      out.push(tok('other', i, depth));
      i++;
    }
  }
  return out;
}

/** Always produce a result set: EXPLAIN returns the plan, FETCH returns rows. */
const ROW_HEADS = new Set(['SELECT', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'FETCH']);
/** Produce rows only with a top-level RETURNING. */
const DML_HEADS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);
/** Refused inside the implicit transaction the extended protocol opens, or unpreparable. */
const SIMPLE_HEADS = new Set([
  'VACUUM',
  'ANALYZE',
  'ANALYSE',
  'REINDEX',
  'CLUSTER',
  'CHECKPOINT',
  'DISCARD',
  'LISTEN',
  'UNLISTEN',
  'NOTIFY',
  'COPY',
]);

function classifyRows(toks: Token[]): boolean {
  const words = toks.filter((t) => t.kind === 'word');
  const first = words[0]?.value;
  if (!first) return false;
  if (ROW_HEADS.has(first)) return true;
  const hasTopReturning = () => words.some((w) => w.depth === 0 && w.value === 'RETURNING');
  if (DML_HEADS.has(first)) return hasTopReturning();
  if (first === 'WITH') {
    // Every CTE body sits inside parens, so the outer statement is the first
    // query-or-DML keyword still at depth 0.
    const head = words.find((w) => w.depth === 0 && (ROW_HEADS.has(w.value) || DML_HEADS.has(w.value)));
    if (!head) return false;
    return DML_HEADS.has(head.value) ? hasTopReturning() : true;
  }
  return false;
}

function classifySimple(toks: Token[]): boolean {
  const words = toks.filter((t) => t.kind === 'word');
  const first = words[0]?.value ?? '';
  if (SIMPLE_HEADS.has(first)) return true;
  const top = words.filter((w) => w.depth === 0).map((w) => w.value);
  const second = top[1];
  if ((first === 'CREATE' || first === 'DROP') && (second === 'DATABASE' || second === 'TABLESPACE')) return true;
  if (first === 'ALTER' && second === 'SYSTEM') return true;
  if (first === 'CREATE' || first === 'DROP' || first === 'REFRESH') {
    // CONCURRENTLY counts only where the grammar puts it: directly after INDEX or VIEW.
    for (let i = 1; i < top.length; i++) {
      const prev = top[i - 1];
      if (top[i] === 'CONCURRENTLY' && (prev === 'INDEX' || prev === 'VIEW')) return true;
    }
  }
  return false;
}

export function splitStatements(script: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let from = 0;
  const flush = (end: number) => {
    const raw = script.slice(from, end);
    const sql = raw.trim();
    if (!sql) return;
    const toks = tokenize(sql);
    if (toks.length === 0) return; // comments only
    out.push({
      sql,
      offset: from + (raw.length - raw.trimStart().length),
      firstWord: toks.find((t) => t.kind === 'word')?.value ?? '',
      returnsRows: classifyRows(toks),
      simpleOnly: classifySimple(toks),
    });
  };
  for (const t of tokenize(script)) {
    if (t.kind !== 'semi') continue;
    flush(t.start);
    from = t.start + 1;
  }
  flush(script.length); // trailing statement without a semicolon, or unterminated text at EOF
  return out;
}

export function returnsRows(sql: string): boolean {
  return classifyRows(tokenize(sql));
}

export function needsSimpleProtocol(sql: string): boolean {
  return classifySimple(tokenize(sql));
}
