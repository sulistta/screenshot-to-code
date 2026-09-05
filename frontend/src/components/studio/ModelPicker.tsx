import { native } from "@/lib/native";
import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { IoChevronDown, IoCheckmarkSharp } from "react-icons/io5";
import type { Settings } from "@/types";
import type { ModelOption } from "./modelOptions";

// Pure helpers live in modelOptions.ts (react-refresh: one component per file).
import { buildModelOptions, modelDisplayName } from "./modelOptions";

interface ModelPickerProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  settings: Settings | null;
}

export default function ModelPicker({
  value,
  onChange,
  label,
  placeholder,
  settings,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ModelOption[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    native<ModelOption[]>("list_models")
      .then(setEntries)
      .catch(() => undefined);
  }, []);

  const options = buildModelOptions(entries, settings);

  // Group order: Default, then providers in first-seen order.
  const groups: Map<string, ModelOption[]> = new Map();
  groups.set("Default", [{ value: "", group: "Default" }]);
  for (const option of options) {
    if (!groups.has(option.group)) groups.set(option.group, []);
    groups.get(option.group)!.push(option);
  }

  const currentLabel = value
    ? modelDisplayName(value)
    : placeholder ?? "Best available";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 -mx-1.5 text-[11px] text-foreground/80 hover:bg-secondary transition-colors"
          title={`${label} model`}
        >
          <span className="text-muted-foreground">{label}</span>
          <span className="font-medium text-foreground truncate max-w-[180px]">
            {currentLabel}
          </span>
          <IoChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-1.5 max-h-[320px] overflow-y-auto"
      >
        <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label} model
        </div>
        {[...groups.entries()].map(([group, groupOptions]) => (
          <div key={group} className="mb-1 last:mb-0">
            {group !== "Default" && (
              <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {group}
              </div>
            )}
            {groupOptions.map((option) => {
              const selected = option.value === value;
              return (
                <button
                  key={option.value || "__default__"}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                    selected
                      ? "bg-secondary text-foreground"
                      : "hover:bg-secondary/60 text-foreground/90"
                  }`}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">
                    {option.value ? modelDisplayName(option.value) : "Best available"}
                  </span>
                  {selected && (
                    <IoCheckmarkSharp className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
