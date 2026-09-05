import { useCallback, useEffect, useRef, useState } from "react";

export const MAX_ATTACHMENTS = 5;

/**
 * Image attachments shared by the creation composer and the conversation
 * composer. Only images are supported; anything else, an over-limit
 * selection, or an unreadable file produces a visible error instead of a
 * silent skip.
 */
export function useImageAttachments(storageKey?: string) {
  const [images, setImages] = useState<string[]>(() => {
    if (!storageKey) return [];
    try {
      const raw = sessionStorage.getItem(storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, MAX_ATTACHMENTS) : [];
    } catch {
      return [];
    }
  });
  const [attachError, setAttachError] = useState<string | null>(null);
  const imagesRef = useRef(images);
  useEffect(() => { imagesRef.current = images; }, [images]);

  const persist = useCallback((next: string[]) => {
    if (!storageKey) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* session persistence is best-effort; the composer keeps working */
    }
  }, [storageKey]);

  const appendDataUrl = useCallback((dataUrl: string) => {
    const current = imagesRef.current;
    if (current.includes(dataUrl) || current.length >= MAX_ATTACHMENTS) return;
    const next = [...current, dataUrl];
    imagesRef.current = next;
    setImages(next);
    persist(next);
  }, [persist]);

  const addFiles = useCallback((input: FileList | File[] | null | undefined) => {
    if (!input) return;
    const files = Array.from(input);
    if (files.length === 0) return;
    const rejected = files.filter((file) => !file.type.startsWith("image/"));
    const accepted = files.filter((file) => file.type.startsWith("image/"));
    if (rejected.length > 0) {
      setAttachError(
        rejected.length === 1
          ? `"${rejected[0].name}" is not an image. Only images can be attached.`
          : `${rejected.length} files are not images. Only images can be attached.`,
      );
    } else {
      setAttachError(null);
    }
    const room = MAX_ATTACHMENTS - imagesRef.current.length;
    if (room <= 0) {
      if (accepted.length > 0) setAttachError(`At most ${MAX_ATTACHMENTS} images. Remove one to add another.`);
      return;
    }
    const withinLimit = accepted.slice(0, room);
    if (accepted.length > room) {
      setAttachError(`At most ${MAX_ATTACHMENTS} images. Remove one to add another.`);
    }
    withinLimit.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => appendDataUrl(String(reader.result));
      reader.onerror = () => setAttachError(`Could not read "${file.name}". The file was skipped.`);
      reader.readAsDataURL(file);
    });
  }, [appendDataUrl]);

  const removeAt = useCallback((index: number) => {
    const next = imagesRef.current.filter((_, i) => i !== index);
    imagesRef.current = next;
    setImages(next);
    persist(next);
  }, [persist]);

  const clear = useCallback(() => {
    imagesRef.current = [];
    setImages([]);
    setAttachError(null);
    if (storageKey) {
      try { sessionStorage.removeItem(storageKey); } catch { /* ignore */ }
    }
  }, [storageKey]);

  return { images, attachError, setAttachError, addFiles, removeAt, clear };
}

export default useImageAttachments;
