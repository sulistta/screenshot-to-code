import { ReactNode, useRef, useState } from "react";

interface Props {
  draft: string; onDraft: (value: string) => void;
  images: string[]; onImages: (value: string[]) => void;
  submitting: boolean; working: boolean; hasResult: boolean;
  onSubmit: () => void; configuration: ReactNode;
}
export default function BriefComposer({ draft, onDraft, images, onImages, submitting, working, hasResult, onSubmit, configuration }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images); imagesRef.current = images;
  const [attachmentError, setAttachmentError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const attach = async (files: File[]) => {
    if (reading) return;
    setAttachmentError("");
    if (files.some((file) => !file.type.startsWith("image/"))) {
      setAttachmentError("References support images. Add URLs in your brief, or use Project tools to import a ZIP.");
    }
    const supported = files.filter((file) => file.type.startsWith("image/"));
    if (supported.some((file) => file.size > 8_000_000)) {
      setAttachmentError("Choose images under 8 MB each."); return;
    }
    if (supported.length + imagesRef.current.length > 5) {
      setAttachmentError("You can attach up to five images. Remove one to add another."); return;
    }
    setReading(true);
    try {
      const loaded = await Promise.all(supported.map((file) => new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read the image. Try selecting it again."));
        reader.readAsDataURL(file);
      })));
      onImages([...new Set([...imagesRef.current, ...loaded])].slice(0, 5));
    } catch (error) { setAttachmentError(error instanceof Error ? error.message : "Could not attach images."); }
    finally { setReading(false); }
  };
  return <div className="brief-composer" data-dragging={dragging} onDragEnter={() => setDragging(true)} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
    event.preventDefault(); setDragging(false); if (!submitting) void attach(Array.from(event.dataTransfer.files));
  }}>
    <label className="sr-only" htmlFor="project-brief">{hasResult ? "Describe a refinement" : "Project brief"}</label>
    <textarea id="project-brief" value={draft} onChange={(event) => onDraft(event.target.value)}
      placeholder={working ? "Note your next change while work continues…" : hasResult ? "What would you like to change?" : "Describe the experience you want to create…"}
      disabled={submitting} rows={hasResult ? 2 : 4}
      onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit(); } }}
      onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); void attach(Array.from(event.clipboardData.files)); } }} />
    {!!images.length && <div className="reference-strip" aria-label="Attached references">{images.map((image, index) => <figure key={image}>
      <img src={image} alt={`Reference ${index + 1}`} /><button disabled={submitting} aria-label={`Remove reference ${index + 1}`} onClick={() => onImages(images.filter((_, i) => i !== index))}>×</button>
    </figure>)}</div>}
    {attachmentError && <p className="inline-error" role="alert">{attachmentError}</p>}
    <div className="composer-footer">
      <button className="attach-button" onClick={() => input.current?.click()} disabled={submitting || reading}>{reading ? "Reading…" : "+ References"}</button>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(event) => { void attach(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      <div className="composer-config">{configuration}</div>
      <button className="primary-action" onClick={onSubmit} disabled={working || submitting || reading || (!draft.trim() && !images.length)}>
        {submitting ? "Starting…" : working ? "Working" : hasResult ? "Refine" : "Create"} <span aria-hidden="true">↗</span>
      </button>
    </div>
    <div className="composer-hint">{working ? "Your next instruction stays here until this run finishes." : "Text, links, or up to 5 reference images"}<span>⌘ / Ctrl + Enter</span></div>
  </div>;
}
