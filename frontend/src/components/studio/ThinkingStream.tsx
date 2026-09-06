import { wrapThinking } from "./wrapThinking";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStudioStore } from "@/store/studio-store";

/** Displays only reasoning text actually published by the provider. */
export default function ThinkingStream() {
  const activity = useStudioStore((s) => s.activity);
  const thinking = useMemo(() => {
    const blocks: typeof activity = [];
    for (const item of activity) {
      if (item.kind !== "thinking" || !item.text) continue;
      const previous = blocks[blocks.length - 1];
      if (previous && previous.agentId === item.agentId) previous.text += item.text;
      else blocks.push({ ...item });
    }
    return blocks;
  }, [activity]);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(thinking);
  const viewport = useRef<HTMLDivElement>(null);
  const [lineWidth, setLineWidth] = useState(0);
  const [displayed, setDisplayed] = useState(true);
  const measure = useRef<(text: string) => number>((text) => text.length * 7);
  const hasText = visible.length > 0;
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const update = () => {
      setDisplayed(node.clientWidth > 0);
      if (!node.clientWidth) return;
      const style = getComputedStyle(node);
      const context = document.createElement("canvas").getContext("2d");
      if (context) {
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        measure.current = (text) => context.measureText(text).width;
      }
      setLineWidth(node.clientWidth);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasText]);
  useEffect(() => { if (!paused) setVisible(thinking); }, [thinking, paused]);
  const [firstRow, setFirstRow] = useState(0);
  const rowRef = useRef(0);
  const lens = () => {
    const node = viewport.current;
    if (!node) return;
    const top = node.scrollTop;
    const first = Math.max(0, Math.floor((top - 75) / 25.2) - 2);
    if (rowRef.current !== first) { rowRef.current = first; setFirstRow(first); }
    // Fixed line metrics avoid synchronous layout reads after style writes.
    for (const line of node.querySelectorAll<HTMLElement>(".thinking-line")) {
      const center = Number(line.dataset.row) * 25.2 + 75 + 12.6 - top;
      const distance = Math.min(1, Math.abs(center - 90) / 90);
      line.style.transform = `scaleX(${1 - distance * .22})`;
      line.style.opacity = String(1 - distance * .75);
    }
  };
  const cache = useRef(new Map<string, { text: string; width: number; lines: string[] }>());
  const rows = useMemo(() => {
    const result: { text: string; key: string }[] = [];
    for (const [index, block] of visible.entries()) {
      const old = cache.current.get(block.id);
      let lines: string[];
      if (old && old.width === lineWidth && old.text === block.text) lines = old.lines;
      else if (old && old.width === lineWidth && block.text.startsWith(old.text)) {
        const stable = old.lines.slice(0, -1);
        const tail = (old.lines.at(-1) ?? "") + block.text.slice(old.text.length);
        lines = [...stable, ...wrapThinking(tail, lineWidth, measure.current)];
      } else lines = wrapThinking(block.text, lineWidth, measure.current);
      cache.current.set(block.id, { text: block.text, width: lineWidth, lines });
      if (index && block.agentId !== visible[index - 1].agentId) result.push({ text: block.agentName || block.agentId || "Coordinator", key: `${block.id}:name` });
      lines.forEach((text, row) => result.push({ text, key: `${block.id}:${row}` }));
    }
    const ids = new Set(visible.map((block) => block.id));
    for (const key of cache.current.keys()) if (!ids.has(key)) cache.current.delete(key);
    return result;
  }, [visible, lineWidth]);
  const target = useRef(0);
  useEffect(() => {
    if (viewport.current) {
      target.current = Math.max(0, viewport.current.scrollHeight - viewport.current.clientHeight);
      if (!paused && window.matchMedia("(prefers-reduced-motion: reduce)").matches) viewport.current.scrollTop = target.current;
    }
    lens();
  }, [rows, paused, firstRow]);
  useEffect(() => {
    if (paused || !hasText || !displayed) return;
    const node = viewport.current;
    if (!node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      node.scrollTop = target.current;
      return;
    }
    let frame: number;
    let previous = performance.now();
    let position = node.scrollTop;
    const advance = (now: number) => {
      const elapsed = Math.min(64, now - previous);
      previous = now;
      const remaining = target.current - position;
      if (remaining > .5) {
        position += Math.min(remaining, elapsed * Math.min(120, Math.max(32, remaining * .6)) / 1000);
        node.scrollTop = position;
        lens();
        frame = requestAnimationFrame(advance);
      }
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [paused, hasText, displayed, rows.length]);
  if (!visible.length) return null;
  const latest = visible[visible.length - 1];
  return <section className="thinking-stream" aria-label="Live thinking">
    <div className="thinking-heading"><span>{latest.agentName || "Coordinator"} · Thinking</span><button onClick={() => setPaused(!paused)} aria-pressed={paused}>{paused ? "Resume" : "Pause"}</button></div>
    <div className="thinking-viewport" ref={viewport} onScroll={lens} tabIndex={0} aria-label="Thinking text">
      <div className="thinking-lines" style={{ height: rows.length * 25.2 + 150, position: "relative" }}>
        {rows.slice(firstRow, firstRow + 14).map((row, index) => <p className="thinking-line" data-row={firstRow + index} key={row.key} style={{ position: "absolute", top: 75 + (firstRow + index) * 25.2, width: "100%", height: 25.2 }}>{row.text || "\u00a0"}</p>)}
      </div>
    </div>
  </section>;
}


