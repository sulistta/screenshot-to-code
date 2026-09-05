import { useEffect, useRef } from "react";
import { Annotation } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";

const externalUpdate = Annotation.define<boolean>();

export default function SourceEditor({ path, value, onChange }: {
  path: string; value: string; onChange: (value: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const initial = useRef(value);
  initial.current = value;
  useEffect(() => {
    if (!host.current) return;
    const extension = path.endsWith(".py") ? python() : path.endsWith(".css") ? css()
      : path.endsWith(".json") ? json() : /\.[jt]sx?$/.test(path)
        ? javascript({ typescript: /\.tsx?$/.test(path), jsx: true }) : html();
    const view = new EditorView({
      parent: host.current, doc: initial.current,
      extensions: [basicSetup, extension, EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": `Source: ${path}` }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalUpdate))) change.current(update.state.doc.toString());
        }),
        EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
      ],
    });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, [path]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: externalUpdate.of(true),
    });
  }, [value]);
  return <div ref={host} className="source-editor" />;
}
