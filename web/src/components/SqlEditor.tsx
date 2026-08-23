import { useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { CompletionSnapshot } from '@shared/protocol';
import {
  THEME_DARK,
  THEME_LIGHT,
  defineThemes,
  registerCompletion,
  registerPgLanguage,
  setCompletionSource,
  statementAtOffset,
} from '@/lib/monacoPg';

type Ed = Parameters<OnMount>[0];
type Mon = Parameters<OnMount>[1];

export type SqlEditorProps = {
  value: string;
  onChange: (v: string) => void;
  connectionId: string;
  completion: CompletionSnapshot | null;
  running: boolean;
  onRun: (sql: string, kind: 'statement' | 'all' | 'selection') => void;
  onCancel: () => void;
  onSave: () => void;
  marker: { offset: number; length?: number; message: string } | null;
  theme: 'light' | 'dark';
  /** the statement Ctrl+Enter would run, so the toolbar can run/explain/export the same thing */
  onStatementChange?: (stmt: { sql: string; start: number; end: number } | null) => void;
};

const MARKERS = 'pg';

// decoration classes live here so the component owns its own styling; React 19 dedupes by href
const CSS = `
.sqlmypg-stmt { background: color-mix(in srgb, var(--p-accent) 12%, transparent); }
.sqlmypg-stmt-margin { background: var(--p-accent); width: 3px !important; margin-left: 3px; border-radius: 3px; }
`;

export default function SqlEditor({
  value,
  onChange,
  connectionId,
  completion,
  running,
  onRun,
  onCancel,
  onSave,
  marker,
  theme,
  onStatementChange,
}: SqlEditorProps) {
  const edRef = useRef<Ed | null>(null);
  const monRef = useRef<Mon | null>(null);
  const decoRef = useRef<ReturnType<Ed['createDecorationsCollection']> | null>(null);
  const runningKey = useRef<{ set: (v: boolean) => void } | null>(null);
  const [mounted, setMounted] = useState(false);

  // handlers in refs: the actions are registered once but must always call today's props
  const onRunRef = useRef(onRun);
  const onCancelRef = useRef(onCancel);
  const onSaveRef = useRef(onSave);
  const runningRef = useRef(running);
  const stmtRef = useRef(onStatementChange);
  onRunRef.current = onRun;
  onCancelRef.current = onCancel;
  onSaveRef.current = onSave;
  runningRef.current = running;
  stmtRef.current = onStatementChange;

  /** offset in the document where the last run started: pg error positions are relative to it */
  const runBase = useRef(0);

  // one model per editor instance, with the connection in the URI so the completion provider
  // knows which snapshot to read
  const uid = useRef(Math.random().toString(36).slice(2));
  const path = `file:///${encodeURIComponent(connectionId)}/${uid.current}.sql`;

  useEffect(() => setCompletionSource(connectionId, completion), [connectionId, completion]);
  useEffect(() => runningKey.current?.set(running), [running]);

  const onMount: OnMount = (ed, monaco) => {
    edRef.current = ed;
    monRef.current = monaco;
    decoRef.current = ed.createDecorationsCollection();
    runningKey.current = ed.createContextKey<boolean>('sqlmypgRunning', running);

    const runStatement = () => {
      if (runningRef.current) return;
      const model = ed.getModel();
      const pos = ed.getPosition();
      if (!model || !pos) return;
      const sel = ed.getSelection();
      if (sel && !sel.isEmpty()) {
        runBase.current = model.getOffsetAt(sel.getStartPosition());
        onRunRef.current(model.getValueInRange(sel), 'selection');
        return;
      }
      const stmt = statementAtOffset(model.getValue(), model.getOffsetAt(pos));
      if (!stmt) return;
      runBase.current = stmt.start;
      onRunRef.current(stmt.sql, 'statement');
    };

    const runAll = () => {
      if (runningRef.current) return;
      const model = ed.getModel();
      if (!model) return;
      runBase.current = 0;
      onRunRef.current(model.getValue(), 'all');
    };

    ed.addAction({
      id: 'sqlmypg.runStatement',
      label: 'Run statement at cursor',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      contextMenuGroupId: 'sqlmypg',
      contextMenuOrder: 1,
      run: runStatement,
    });
    ed.addAction({
      id: 'sqlmypg.runAll',
      label: 'Run whole script',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, monaco.KeyCode.F5],
      contextMenuGroupId: 'sqlmypg',
      contextMenuOrder: 2,
      run: runAll,
    });
    ed.addAction({
      id: 'sqlmypg.cancel',
      label: 'Cancel running query',
      keybindings: [monaco.KeyCode.Escape],
      // only steal Escape while a query runs and no widget wants it first
      keybindingContext: 'sqlmypgRunning && !suggestWidgetVisible && !findWidgetVisible',
      run: () => onCancelRef.current(),
    });
    ed.addAction({
      id: 'sqlmypg.save',
      label: 'Save query',
      // registered on the editor, so it also stops the browser's own Save Page dialog
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      contextMenuGroupId: 'sqlmypg',
      contextMenuOrder: 3,
      run: () => onSaveRef.current(),
    });

    // highlight the statement Ctrl+Enter would run: without it a multi-statement script is guesswork
    const paint = () => {
      const model = ed.getModel();
      const pos = ed.getPosition();
      const deco = decoRef.current;
      if (!model || !pos || !deco) return;
      const sel = ed.getSelection();
      const stmt =
        sel && !sel.isEmpty() ? null : statementAtOffset(model.getValue(), model.getOffsetAt(pos));
      stmtRef.current?.(stmt);
      if (!stmt) {
        deco.clear();
        return;
      }
      const a = model.getPositionAt(stmt.start);
      const b = model.getPositionAt(stmt.end);
      deco.set([
        {
          range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column),
          options: { className: 'sqlmypg-stmt', linesDecorationsClassName: 'sqlmypg-stmt-margin' },
        },
      ]);
    };
    ed.onDidChangeCursorPosition(paint);
    ed.onDidChangeModelContent(paint);
    paint();

    setMounted(true);
  };

  useEffect(() => {
    const ed = edRef.current;
    const monaco = monRef.current;
    const model = ed?.getModel();
    if (!ed || !monaco || !model) return;
    if (!marker) {
      monaco.editor.setModelMarkers(model, MARKERS, []);
      return;
    }
    // the server reports the position inside the sql we submitted, so shift it back into the document
    const from = marker.offset + runBase.current;
    const start = model.getPositionAt(from);
    const end = model.getPositionAt(from + Math.max(1, marker.length ?? 1));
    monaco.editor.setModelMarkers(model, MARKERS, [
      {
        severity: monaco.MarkerSeverity.Error,
        message: marker.message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
    ]);
    ed.revealPositionInCenterIfOutsideViewport(start);
  }, [marker, mounted]);

  return (
    <>
      <style href="sqlmypg-editor" precedence="default">
        {CSS}
      </style>
      <Editor
        language="pgsql"
        path={path}
        value={value}
        theme={theme === 'dark' ? THEME_DARK : THEME_LIGHT}
        height="100%"
        loading={<div className="p-3 text-sm text-muted">Loading editor</div>}
        beforeMount={(monaco) => {
          registerPgLanguage(monaco);
          registerCompletion(monaco);
          defineThemes(monaco);
        }}
        onMount={onMount}
        onChange={(v) => onChange(v ?? '')}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineHeight: 20,
          fontFamily: "'JetBrains Mono', 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace",
          lineNumbers: 'on',
          renderWhitespace: 'selection',
          wordWrap: 'off',
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          smoothScrolling: true,
          padding: { top: 8, bottom: 8 },
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        }}
      />
    </>
  );
}
