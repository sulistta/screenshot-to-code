import type { StudioActivityItem } from "@/store/studio-store";

function ActivityItem({ item }: { item: StudioActivityItem }) {
  if (item.kind === "thinking") {
    return (
      <div className="text-xs italic text-stone-400 whitespace-pre-wrap leading-relaxed">
        {item.text}
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="text-[13px] whitespace-pre-wrap leading-relaxed text-stone-700 dark:text-zinc-200">
        {item.text}
      </div>
    );
  }
  if (item.kind === "tool") {
    const failed = item.ok === false;
    const done = item.ok === true;
    const summary = item.toolDetail || item.toolName;
    return (
      <div
        className={`flex items-center gap-2 text-[12px] ${failed ? "text-red-600" : "text-stone-500 dark:text-zinc-400"}`}
        title={item.toolName}
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${failed ? "bg-red-500" : done ? "bg-emerald-500" : "bg-blue-500 animate-pulse"}`}
        />
        <span className="truncate">{failed ? `${summary} — failed` : summary}</span>
      </div>
    );
  }
  return <div className="text-xs text-stone-400">{item.text}</div>;
}

export default ActivityItem;
