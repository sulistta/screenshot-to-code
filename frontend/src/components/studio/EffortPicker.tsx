import { useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { IoChevronDown, IoCheckmarkSharp } from "react-icons/io5";
import { EFFORT_LABELS } from "./modelOptions";

interface EffortPickerProps {
  label: string;
  value: string;
  /** Levels the selected model supports; "Default" is always offered. */
  efforts: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

/** Reasoning effort for one role (primary model or subagents). Effort is a
 *  request parameter, so it is chosen independently of the model. */
export default function EffortPicker({
  label,
  value,
  efforts,
  onChange,
  disabled = false,
}: EffortPickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const levels = ["", ...efforts];
  const currentLabel = EFFORT_LABELS[value] ?? value;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          disabled={disabled}
          aria-label={`${label}: ${currentLabel}`}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 -mx-1.5 text-[11px] text-foreground/80 hover:bg-secondary transition-colors"
          title={`${label} effort level`}
        >
          <span className="text-muted-foreground">{label}</span>
          <span className="font-medium text-foreground truncate max-w-[120px]">
            {currentLabel}
          </span>
          <IoChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44 p-1.5">
        <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Reasoning effort
        </div>
        {levels.map((level) => {
          const selected = level === value;
          return (
            <button
              key={level || "__default__"}
              className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                selected
                  ? "bg-secondary text-foreground"
                  : "hover:bg-secondary/60 text-foreground/90"
              }`}
              onClick={() => {
                onChange(level);
                setOpen(false);
              }}
            >
              <span className="truncate">{EFFORT_LABELS[level] ?? level}</span>
              {selected && (
                <IoCheckmarkSharp className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
              )}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
