import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FiMinus, FiSquare, FiCopy, FiX } from "react-icons/fi";
import { useStudioStore } from "@/store/studio-store";

export default function WindowTitlebar({ crumb }: { crumb: ReactNode }) {
  const [maximized, setMaximized] = useState(false);
  const setError = useStudioStore((state) => state.setError);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    const update = () => { void win.isMaximized().then((value) => { if (!disposed) setMaximized(value); }).catch(() => undefined); };
    update();
    void win.onResized(update).then((off) => { if (disposed) off(); else unlisten = off; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const act = async (action: "minimize" | "toggleMaximize" | "close") => {
    try { await getCurrentWindow()[action](); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <header className="forge-topbar" data-tauri-drag-region>
    <div className="forge-crumb min-w-0 pointer-events-none">{crumb}</div>
    <div className="forge-titlebar-drag" data-tauri-drag-region />
    <div className="forge-env">
      <div className="forge-win" aria-label="Window controls">
        <button aria-label="Minimize" title="Minimize" onClick={() => void act("minimize")}><FiMinus /></button>
        <button aria-label={maximized ? "Restore window" : "Maximize"} title={maximized ? "Restore window" : "Maximize"} onClick={() => void act("toggleMaximize")}>{maximized ? <FiCopy /> : <FiSquare />}</button>
        <button aria-label="Close" title="Close" className="forge-window-close" onClick={() => void act("close")}><FiX /></button>
      </div>
    </div>
  </header>;
}
