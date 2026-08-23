import { loader } from '@monaco-editor/react';
import type { Monaco } from '@monaco-editor/react';
import * as monacoEditor from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import type { CompletionSnapshot, RelKind } from '@shared/protocol';

// Monaco is bundled from the local package instead of @monaco-editor/react's default jsdelivr
// CDN. This page holds database credentials, so it must not pull a third-party script into
// itself, and a self-hosted install has to work with no internet at all. (The CDN default also
// pins a different monaco version than the one in package.json.)
// SQL needs no language worker - this one backs diffing and link detection, and its absence is
// what triggers Monaco's "define MonacoEnvironment.getWorker" warning.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco: monacoEditor });

type Relation = CompletionSnapshot['relations'][number];

export const THEME_LIGHT = 'sqlmypg-light';
export const THEME_DARK = 'sqlmypg-dark';

/* ------------------------------- completion ------------------------------- */

/** connectionId -> snapshot plus a lookup index built once when the snapshot is set. */
const sources = new Map<string, { snap: CompletionSnapshot; byKey: Map<string, Relation> }>();

export function setCompletionSource(connectionId: string, snap: CompletionSnapshot | null): void {
  if (!snap) {
    sources.delete(connectionId);
    return;
  }
  const byKey = new Map<string, Relation>();
  for (const r of snap.relations) {
    byKey.set(`${r.schema}.${r.name}`.toLowerCase(), r);
    // bare name: first one wins, close enough to search_path order
    if (!byKey.has(r.name.toLowerCase())) byKey.set(r.name.toLowerCase(), r);
  }
  sources.set(connectionId, { snap, byKey });
}

/** Editors carry their connection in the model URI: file:///<connectionId>/<uid>.sql */
function sourceForModelPath(path: string) {
  const seg = path.split('/')[1];
  return seg ? sources.get(decodeURIComponent(seg)) : undefined;
}

const KEYWORDS = [
  'select', 'from', 'where', 'group by', 'having', 'order by', 'limit', 'offset', 'distinct',
  'distinct on', 'join', 'left join', 'right join', 'full join', 'inner join', 'cross join',
  'lateral', 'on', 'using', 'as', 'and', 'or', 'not', 'is null', 'is not null', 'in', 'exists',
  'between', 'like', 'ilike', 'case', 'when', 'then', 'else', 'end', 'union', 'union all',
  'except', 'intersect', 'with', 'with recursive', 'insert into', 'values', 'on conflict',
  'do nothing', 'do update set', 'returning', 'update', 'set', 'delete from', 'truncate',
  'create table', 'create index', 'create view', 'create materialized view', 'alter table',
  'drop table', 'add column', 'begin', 'commit', 'rollback', 'savepoint', 'explain',
  'explain analyze', 'analyze', 'vacuum', 'grant', 'revoke', 'for update', 'asc', 'desc',
  'nulls first', 'nulls last', 'coalesce', 'window', 'partition by',
];

// the alias slot of FROM_RE frequently catches a keyword instead of a real alias
const ALIAS_STOP = new Set([
  'on', 'using', 'where', 'set', 'group', 'order', 'having', 'limit', 'offset', 'join', 'left',
  'right', 'full', 'inner', 'cross', 'outer', 'natural', 'lateral', 'returning', 'values',
  'select', 'and', 'or', 'as', 'from', 'into', 'update', 'delete', 'with', 'union', 'except',
  'intersect', 'window', 'fetch', 'for', 'tablesample', 'only',
]);

// ponytail: regex scrape of FROM/JOIN/UPDATE/INTO, blind to CTEs, subqueries and derived tables;
// upgrade path is a real parser (pgsql-ast-parser) once column suggestions start pointing at the
// wrong relation.
const FROM_RE =
  /\b(?:from|join|update|into)\s+("?[\w$]+"?(?:\s*\.\s*"?[\w$]+"?)?)(?:\s+(?:as\s+)?("?[\w$]+"?))?/gi;

function mentionedRelations(stmt: string, byKey: Map<string, Relation>): Map<string, Relation> {
  const out = new Map<string, Relation>();
  for (const m of stmt.matchAll(FROM_RE)) {
    const rel = byKey.get((m[1] ?? '').replace(/["\s]/g, '').toLowerCase());
    if (!rel) continue;
    out.set(rel.name.toLowerCase(), rel);
    const alias = m[2]?.replace(/"/g, '').toLowerCase();
    if (alias && !ALIAS_STOP.has(alias)) out.set(alias, rel);
  }
  return out;
}

const kindLabel = (k: RelKind) =>
  k === 'matview' ? 'materialized view' : k === 'partitioned' ? 'partitioned table' : k;

const q = (id: string) => (/^[a-z_][a-z0-9_$]*$/.test(id) ? id : `"${id.replace(/"/g, '""')}"`);

let completionRegistered = false;

/**
 * ONE provider for the whole app. Registering inside a component (i.e. per editor instance) leaks
 * the disposable on unmount and multiplies every suggestion by the number of mounted editors.
 */
export function registerCompletion(monaco: Monaco): void {
  if (completionRegistered) return;
  completionRegistered = true;

  monaco.languages.registerCompletionItemProvider('pgsql', {
    triggerCharacters: ['.'],
    provideCompletionItems(model: monacoEditor.editor.ITextModel, position: monacoEditor.Position) {
      const src = sourceForModelPath(model.uri.path);
      if (!src) return { suggestions: [] };
      const { snap, byKey } = src;

      const text = model.getValue();
      const stmt = statementAtOffset(text, model.getOffsetAt(position))?.sql ?? text;
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const lineToCursor = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const qualifier = /("?[\w$]+"?)\s*\.\s*[\w$]*$/
        .exec(lineToCursor)?.[1]
        ?.replace(/"/g, '')
        .toLowerCase();

      const K = monaco.languages.CompletionItemKind;
      const col = (r: Relation, c: string) => ({
        label: c,
        kind: K.Field,
        detail: `column ${r.schema}.${r.name}`,
        insertText: q(c),
        range,
        sortText: `0${c}`,
      });
      const rel = (r: Relation, label: string, insertText: string, sort: string) => ({
        label,
        kind: r.kind === 'view' || r.kind === 'matview' ? K.Interface : K.Struct,
        detail: `${kindLabel(r.kind)} ${r.schema}.${r.name}`,
        insertText,
        range,
        sortText: `${sort}${label}`,
      });

      const mentioned = mentionedRelations(stmt, byKey);

      if (qualifier) {
        const target = mentioned.get(qualifier) ?? byKey.get(qualifier);
        if (target) return { suggestions: target.columns.map((c) => col(target, c)) };
        const schema = snap.schemas.find((s) => s.toLowerCase() === qualifier);
        if (schema) {
          return {
            suggestions: snap.relations
              .filter((r) => r.schema === schema)
              .map((r) => rel(r, r.name, q(r.name), '1')),
          };
        }
        return { suggestions: [] };
      }

      const inStmt = [...new Set(mentioned.values())];
      return {
        suggestions: [
          ...inStmt.flatMap((r) => r.columns.map((c) => col(r, c))),
          ...inStmt.map((r) => rel(r, r.name, q(r.name), '1')),
          ...snap.relations.map((r) => rel(r, r.name, q(r.name), '2')),
          ...snap.relations.map((r) =>
            rel(r, `${r.schema}.${r.name}`, `${q(r.schema)}.${q(r.name)}`, '3'),
          ),
          ...snap.schemas.map((s) => ({
            label: s,
            kind: K.Module,
            detail: 'schema',
            insertText: q(s),
            range,
            sortText: `4${s}`,
          })),
          ...snap.functions.map((f) => ({
            label: f,
            kind: K.Function,
            detail: 'function',
            insertText: f.replace(/\(.*$/, '('),
            range,
            sortText: `5${f}`,
          })),
          ...KEYWORDS.map((k) => ({
            label: k,
            kind: K.Keyword,
            detail: 'keyword',
            insertText: k,
            range,
            sortText: `6${k}`,
          })),
        ],
      };
    },
  });
}

/* -------------------------------- language -------------------------------- */

let languageRegistered = false;

/**
 * Monaco already ships a 'pgsql' monarch tokenizer, only the editing config around it is thin.
 * ponytail: dollar-quoted bodies still tokenise as operators + identifiers, upgrade path is
 * setMonarchTokensProvider with a copy of the built-in pgsql rules plus a $$ state.
 */
export function registerPgLanguage(monaco: Monaco): void {
  if (languageRegistered) return;
  languageRegistered = true;

  monaco.languages.setLanguageConfiguration('pgsql', {
    comments: { lineComment: '--', blockComment: ['/*', '*/'] },
    brackets: [
      ['(', ')'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: "'", close: "'", notIn: ['string', 'comment'] },
      { open: '"', close: '"', notIn: ['string', 'comment'] },
    ],
    surroundingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: "'", close: "'" },
      { open: '"', close: '"' },
    ],
    // $ is an identifier character in pg, so keep it inside the word
    wordPattern: /[\w$]+/g,
  });
}

/* --------------------------------- themes --------------------------------- */

export function defineThemes(monaco: Monaco): void {
  monaco.editor.defineTheme(THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment.sql', foreground: '6e7781', fontStyle: 'italic' },
      { token: 'keyword.sql', foreground: 'cf222e' },
      { token: 'operator.sql', foreground: '57606a' },
      { token: 'string.sql', foreground: '0a3069' },
      { token: 'number.sql', foreground: '953800' },
      { token: 'predefined.sql', foreground: '8250df' },
      { token: 'identifier.sql', foreground: '0550ae' },
      { token: 'delimiter.sql', foreground: '57606a' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1b1f24',
      'editor.lineHighlightBackground': '#f5f6f8',
      'editor.selectionBackground': '#ddf0ff',
      'editorLineNumber.foreground': '#a0a8b4',
      'editorLineNumber.activeForeground': '#1b1f24',
      'editorCursor.foreground': '#1257c9',
      'editorIndentGuide.background1': '#eceef1',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#ccd1d9',
      'editorSuggestWidget.background': '#ffffff',
      'editorSuggestWidget.border': '#ccd1d9',
      'editorSuggestWidget.selectedBackground': '#ddf0ff',
      'editorBracketMatch.background': '#ddf0ff',
      'editorBracketMatch.border': '#1f6feb',
    },
  });

  monaco.editor.defineTheme(THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment.sql', foreground: '8b949e', fontStyle: 'italic' },
      { token: 'keyword.sql', foreground: 'ff7b72' },
      { token: 'operator.sql', foreground: '9aa3b2' },
      { token: 'string.sql', foreground: '7ee787' },
      { token: 'number.sql', foreground: 'ffa657' },
      { token: 'predefined.sql', foreground: 'd2a8ff' },
      // the same hue the app prints schema and relation names in, so an identifier reads as one
      { token: 'identifier.sql', foreground: '79c0ff' },
      { token: 'delimiter.sql', foreground: '9aa3b2' },
    ],
    colors: {
      'editor.background': '#0f1115',
      'editor.foreground': '#e8ebf0',
      'editor.lineHighlightBackground': '#171b22',
      'editor.selectionBackground': '#16304f',
      'editorLineNumber.foreground': '#4a5262',
      'editorLineNumber.activeForeground': '#e8ebf0',
      'editorCursor.foreground': '#6ea8ff',
      'editorIndentGuide.background1': '#1e232c',
      'editorWidget.background': '#1b1f27',
      'editorWidget.border': '#333a45',
      'editorSuggestWidget.background': '#1b1f27',
      'editorSuggestWidget.border': '#333a45',
      'editorSuggestWidget.selectedBackground': '#16304f',
      'editorBracketMatch.background': '#16304f',
      'editorBracketMatch.border': '#6ea8ff',
    },
  });
}

/* ------------------------------ statement split ---------------------------- */

// ASCII tags only ($$, $body$), which covers every dollar quote anyone actually writes
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_$]*)?\$/;

function cut(sql: string, from: number, to: number) {
  let s = from;
  let e = to;
  while (s < e && /\s/.test(sql[s]!)) s++;
  while (e > s && /\s/.test(sql[e - 1]!)) e--;
  return s === e ? null : { sql: sql.slice(s, e), start: s, end: e };
}

/**
 * The statement containing `offset`, split on top-level semicolons only. Same hazards the server's
 * splitter deals with: quoted strings and identifiers, E'' backslash escapes, dollar quoting with
 * tags, line comments and nested block comments.
 */
export function statementAtOffset(
  sql: string,
  offset: number,
): { sql: string; start: number; end: number } | null {
  const n = sql.length;
  let start = 0;
  let i = 0;
  /** last complete statement before the caret, used when the caret sits after a trailing ; */
  let prev: [number, number] | null = null;

  while (i < n) {
    const c = sql[i]!;

    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1; // pg nests block comments
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      // backslash escapes only inside E'...'; with standard_conforming_strings on, '\' is literal
      const escapes = c === "'" && (sql[i - 1] === 'e' || sql[i - 1] === 'E');
      i++;
      while (i < n) {
        if (escapes && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2; // doubled quote is an escaped quote, string continues
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
      i++;
      continue;
    }
    if (c === ';') {
      if (offset <= i) return cut(sql, start, i);
      prev = [start, i];
      start = ++i;
      continue;
    }
    i++;
  }
  // Past the last semicolon: whatever follows it, or - when that is only whitespace or a comment -
  // the statement just before it. Parking the caret right after the trailing semicolon and hitting
  // Ctrl+Enter is the most common way anyone runs a query, and it must not silently do nothing.
  const tail = offset >= start ? cut(sql, start, n) : null;
  if (tail) return tail;
  return prev ? cut(sql, prev[0], prev[1]) : null;
}

// dev-only self check: these offsets drive the error marker, so a bad split puts the squiggle on
// the wrong character of the wrong statement.
if (import.meta.env.DEV) {
  const hit = (s: string, o: number) => statementAtOffset(s, o)?.sql ?? null;
  const script = "select 1; -- ;\nselect ';' , $$a;b$$ /* ; /* ; */ */ from t; select 3";
  const cases: [unknown, unknown, string][] = [
    [hit(script, 0), 'select 1', 'first statement'],
    [hit(script, 20)?.endsWith('from t'), true, 'strings, dollar quotes and nested comments'],
    [hit(script, script.length), 'select 3', 'last statement without a semicolon'],
    [hit('select 1; select 2', 8), 'select 1', 'cursor on the semicolon'],
    [hit('select 1; select 2', 9), 'select 2', 'cursor right after the semicolon'],
    [hit('  ;  ', 1), null, 'empty statement'],
    [hit('select 1;', 9), 'select 1', 'caret parked after the trailing semicolon'],
    [hit('select 1;\n\n', 11), 'select 1', 'caret in trailing whitespace'],
    [hit('select 1; -- done', 17), 'select 1', 'caret after a trailing comment'],
    [hit("select e'\\';' , 1", 3), "select e'\\';' , 1", "backslash escapes inside E''"],
    [hit("select 'c:\\' , 1; x", 0), "select 'c:\\' , 1", 'backslash is literal in plain strings'],
    [hit("select 'it''s;' , 2", 0), "select 'it''s;' , 2", 'doubled quote'],
  ];
  for (const [got, want, what] of cases) console.assert(got === want, what, got);
}
