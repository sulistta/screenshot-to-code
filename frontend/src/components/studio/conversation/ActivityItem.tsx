import type { StudioActivityItem } from "@/store/studio-store";

function ActivityItem({ item }: { item: StudioActivityItem }) {
  if (item.kind === "thinking") {
    return (
      <div className="text-xs italic text-muted-foreground/80 whitespace-pre-wrap leading-relaxed">
        {item.text}
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="text-sm whitespace-pre-wrap leading-relaxed">
        {item.text}
      </div>
    );
  }
  if (item.kind === "tool") {
    const failed = item.ok === false;
    const summary = item.toolDetail || item.toolName;
    return (
      <div
        className={`flex items-center gap-2 text-xs ${
          failed ? "text-destructive" : "text-muted-foreground"
        }`}
        title={item.toolName}
      >
        <span
          className={`inline-block h-1 w-1 rounded-full ${
            failed ? "bg-destructive" : "bg-emerald-600"
          }`}
        />
        <span>{failed ? `${summary} — failed` : summary}</span>
      </div>
    );
  }
  return <div className="text-xs text-muted-foreground/70">{item.text}</div>;
}

export default ActivityItem;
