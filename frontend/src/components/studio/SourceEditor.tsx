import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";

export default function SourceEditor({ path, value, onChange }: {
  path: string; value: string; onChange: (value: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
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
          if (update.docChanged) change.current(update.state.doc.toString());
        }),
        EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
      ],
    });
    return () => view.destroy();
  }, [path]);
  return <div ref={host} className="source-editor" />;
}
