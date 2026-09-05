import { useEffect, useRef, useState } from "react";
import type { Settings } from "@/types";
import { FiArrowUp, FiPaperclip, FiSquare, FiX } from "react-icons/fi";
import ModelPicker from "./ModelPicker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const IDEAS = ["A SaaS landing page for a productivity tool", "An interactive data visualization", "A developer documentation site", "A full-stack web app with authentication"];

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  settings: Settings;
  primary: string;
  subagent: string;
  onModelsChange: (patch: { primaryModel?: string; subagentModel?: string }) => void;
  images: string[];
  onFiles: (files: FileList | File[]) => void;
  onRemove: (index: number) => void;
  error?: string | null;
  busy?: boolean;
  working?: boolean;
  modelsBusy?: boolean;
  onStop?: () => void;
  stopping?: boolean;
  isNew?: boolean;
}

export default function Composer({ value, onChange, onSubmit, settings, primary, subagent, onModelsChange,
  images, onFiles, onRemove, error, busy = false, working = false, modelsBusy = false,
  onStop, stopping = false, isNew = false }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [idea, setIdea] = useState(0);
  const [ideasOpen, setIdeasOpen] = useState(false);
  useEffect(() => {
    if (value || focused || !isNew || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setIdea((i) => (i + 1) % IDEAS.length), 6000);
    return () => window.clearInterval(timer);
  }, [value, focused, isNew]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight || 96, 200)}px`;
  }, [value]);
  useEffect(() => {
    if (isNew && sessionStorage.getItem("forge:focus-composer")) {
      sessionStorage.removeItem("forge:focus-composer");
      input.current?.focus();
    }
  }, [isNew]);
  const placeholder = working ? "Prepare your next change while Forge works…" : isNew ? "Describe what you want to create…" : "What would you like to change?";
  return <div className={`forge-composer forge-prompt ${dragging ? "is-dragging" : ""}`}
    onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={(event) => { event.preventDefault(); setDragging(false); if (!busy) onFiles(event.dataTransfer.files); }}>
    <div className="composer-models">
      <ModelPicker label="Model" value={primary} onChange={(value) => onModelsChange({ primaryModel: value })} settings={settings} disabled={busy || working || modelsBusy} />
      <ModelPicker label="Subagents" value={subagent} placeholder="Automatic" onChange={(value) => onModelsChange({ subagentModel: value })} settings={settings} disabled={busy || working || modelsBusy} />
      {isNew && <Popover open={ideasOpen} onOpenChange={setIdeasOpen}>
        <PopoverTrigger asChild><button className="composer-ideas" disabled={busy}>Ideas</button></PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-2"><div className="flex flex-col gap-1">
          {IDEAS.map((suggestion) => <button key={suggestion} className="text-left text-sm rounded-md p-2 hover:bg-secondary" onClick={() => { onChange(suggestion); setIdeasOpen(false); input.current?.focus(); }}>{suggestion}</button>)}
        </div></PopoverContent>
      </Popover>}
    </div>
    <div className="composer-input">
      <textarea ref={input} aria-label={isNew ? "Project brief" : "Message"} value={value} placeholder={placeholder}
        disabled={busy} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy && !working && !modelsBusy) onSubmit(); } }}
        onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); onFiles(event.clipboardData.files); } }} />
      {isNew && <span key={idea} className={`composer-example ${value || focused ? "example-hidden" : ""}`} aria-hidden="true">Try: {IDEAS[idea]}</span>}
    </div>
    {images.length > 0 && <div className="composer-attachments">{images.map((src, i) => <span key={src}>
      <img src={src} alt={`Reference ${i + 1}`} />
      <button aria-label={`Remove reference ${i + 1}`} onClick={() => onRemove(i)} disabled={busy}><FiX /></button>
    </span>)}</div>}
    {error && <p role="alert" className="composer-error">{error}</p>}
    <div className="composer-actions">
      <button className="forge-tool" aria-label="Attach reference images" onClick={() => fileInput.current?.click()} disabled={busy}><FiPaperclip /> Attach</button>
      <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(event) => { if (event.target.files) onFiles(event.target.files); event.target.value = ""; }} />
      <span className="composer-hint">{dragging ? "Drop your reference images" : modelsBusy ? "Saving models…" : busy ? "Sending…" : working ? "Your draft stays here until you send it" : "Shift + Enter for a new line"}</span>
      {working && onStop ? <button className="forge-send" aria-label="Stop generation" disabled={stopping} onClick={onStop}><FiSquare /></button> :
        <button className="forge-send" aria-label={isNew ? "Create project" : "Send message"} disabled={busy || modelsBusy || (!value.trim() && images.length === 0)} onClick={onSubmit}><FiArrowUp /></button>}
    </div>
  </div>;
}
