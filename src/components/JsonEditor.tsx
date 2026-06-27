import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as tg } from "@lezer/highlight";

export interface JsonEditorHandle {
  /** Move the cursor/selection to a 1-based line and scroll it into view. */
  jumpToLine: (line: number) => void;
}

// Maestro-themed editor chrome, driven by the app's CSS custom properties so it
// follows light/dark + accent automatically (no recompute on theme change).
const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px", backgroundColor: "var(--bg-surface)", color: "var(--text-primary)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace", lineHeight: "1.55", overflow: "auto" },
  ".cm-content": { caretColor: "var(--accent-default)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent-default)" },
  ".cm-gutters": { backgroundColor: "var(--bg-surface)", color: "var(--text-tertiary)", borderRight: "1px solid var(--border-divider)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent-default) 7%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent-default) 7%, transparent)", color: "var(--text-secondary)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "color-mix(in srgb, var(--accent-default) 25%, transparent)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--accent-default) 22%, transparent)", outline: "none" },
  ".cm-panels": { backgroundColor: "var(--bg-card)", color: "var(--text-primary)", borderColor: "var(--border-divider)" },
  ".cm-panel input, .cm-panel button": { fontFamily: "inherit" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--status-warning) 35%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent-default) 40%, transparent)" },
});

// Token colours mapped to Maestro's semantic palette (CSS vars → theme-aware).
const highlightStyle = HighlightStyle.define([
  { tag: tg.propertyName, color: "var(--accent-default)" },
  { tag: [tg.string], color: "var(--status-success)" },
  { tag: [tg.number], color: "var(--status-warning)" },
  { tag: [tg.bool, tg.null, tg.keyword], color: "var(--status-warning)" },
  { tag: [tg.punctuation, tg.separator, tg.brace, tg.bracket], color: "var(--text-tertiary)" },
  { tag: tg.invalid, color: "var(--status-danger)" },
]);

// Thin, horizontally-scrolling JSON symbol bar. `caret` is where to leave the
// cursor inside the inserted text (for paired punctuation).
const SYMBOLS: { label: string; text: string; caret?: number }[] = [
  { label: "{ }", text: "{}", caret: 1 },
  { label: "[ ]", text: "[]", caret: 1 },
  { label: '" "', text: '""', caret: 1 },
  { label: ":", text: ": " },
  { label: ",", text: "," },
  { label: "true", text: "true" },
  { label: "false", text: "false" },
  { label: "null", text: "null" },
];

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSave?: () => void;
  /** Soft-wrap long lines (default true) — fixes the "too wide" editor. */
  wrap?: boolean;
}

export const JsonEditor = forwardRef<JsonEditorHandle, Props>(function JsonEditor(
  { value, onChange, onSave, wrap = true },
  ref,
) {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useImperativeHandle(ref, () => ({
    jumpToLine: (line: number) => {
      const view = cmRef.current?.view;
      if (!view) return;
      const n = Math.min(Math.max(line, 1), view.state.doc.lines);
      const info = view.state.doc.line(n);
      view.dispatch({ selection: { anchor: info.from }, scrollIntoView: true });
      view.focus();
    },
  }));

  const extensions = useMemo(() => {
    const ext = [
      json(),
      linter(jsonParseLinter()),
      lintGutter(),
      syntaxHighlighting(highlightStyle),
      editorTheme,
      keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { onSaveRef.current?.(); return true; } }]),
    ];
    if (wrap) ext.push(EditorView.lineWrapping);
    return ext;
  }, [wrap]);

  const insert = (text: string, caret?: number) => {
    const view = cmRef.current?.view;
    if (!view) return;
    const from = view.state.selection.main.from;
    view.dispatch(view.state.replaceSelection(text));
    if (caret !== undefined) {
      view.dispatch({ selection: { anchor: from + caret } });
    }
    view.focus();
  };

  return (
    <div
      style={{
        display: "flex", flexDirection: "column", flex: 1, minHeight: 0,
        border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)",
        overflow: "hidden", background: "var(--bg-surface)",
      }}
    >
      <div
        style={{
          display: "flex", gap: 4, padding: "4px 6px", flexShrink: 0,
          borderBottom: "1px solid var(--border-divider)", overflowX: "auto", whiteSpace: "nowrap",
        }}
      >
        {SYMBOLS.map((s) => (
          <button
            key={s.label}
            // mouseDown + preventDefault keeps editor focus/selection intact.
            onMouseDown={(e) => { e.preventDefault(); insert(s.text, s.caret); }}
            className="reveal-target"
            style={{
              flexShrink: 0, fontFamily: "monospace", fontSize: 12, lineHeight: 1,
              padding: "3px 8px", borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-default)", background: "var(--bg-card)",
              color: "var(--text-secondary)", cursor: "pointer",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <CodeMirror
          ref={cmRef}
          value={value}
          onChange={onChange}
          extensions={extensions}
          theme="none"
          height="100%"
          style={{ height: "100%" }}
          basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: false }}
        />
      </div>
    </div>
  );
});
