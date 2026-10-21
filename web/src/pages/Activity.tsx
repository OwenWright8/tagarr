import { useQuery } from "@tanstack/react-query";
import { AlertCircle, RefreshCw, ShieldCheck, Tag, TagsIcon, Undo2 } from "lucide-react";
import { get, type Activity } from "@/lib/api";
import { PageHeader } from "@/components/Layout";
import { Card, CardBody, PageSpinner, cn, timeAgo } from "@/components/ui";

const ICON: Record<Activity["kind"], { icon: React.ReactNode; className: string }> = {
  tagged: { icon: <Tag className="h-3.5 w-3.5" />, className: "bg-primary-soft text-primary" },
  untagged: { icon: <Undo2 className="h-3.5 w-3.5" />, className: "bg-muted text-muted-foreground" },
  adopted: { icon: <TagsIcon className="h-3.5 w-3.5" />, className: "bg-muted text-muted-foreground" },
  sync: { icon: <RefreshCw className="h-3.5 w-3.5" />, className: "bg-success/10 text-success" },
  access: { icon: <ShieldCheck className="h-3.5 w-3.5" />, className: "bg-accent/10 text-accent" },
  error: { icon: <AlertCircle className="h-3.5 w-3.5" />, className: "bg-destructive/10 text-destructive" },
};

export function ActivityList({ entries, empty }: { entries: Activity[]; empty: string }) {
  if (!entries.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1">
      {entries.map((a) => {
        const style = ICON[a.kind] ?? ICON.sync;
        return (
          <li key={a.id} className="flex items-start gap-3 rounded-lg py-1.5">
            <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", style.className)}>{style.icon}</span>
            <span className={cn("min-w-0 flex-1 text-sm", a.kind === "error" && "text-destructive")}>{a.message}</span>
            <time className="shrink-0 pt-0.5 text-xs text-muted-foreground" dateTime={new Date(a.at).toISOString()} title={new Date(a.at).toLocaleString()}>
              {timeAgo(a.at)}
            </time>
          </li>
        );
      })}
    </ul>
  );
}

export default function ActivityPage() {
  const activity = useQuery({ queryKey: ["activity"], queryFn: () => get<Activity[]>("/activity?limit=300"), refetchInterval: 30_000 });
  if (!activity.data) return <PageSpinner />;
  return (
    <div className="animate-fade-in">
      <PageHeader title="Activity" description="Every tag Autotagarr wrote or removed, requests it matched, and anything that went wrong." />
      <Card>
        <CardBody>
          <ActivityList entries={activity.data} empty="Nothing has happened yet." />
        </CardBody>
      </Card>
    </div>
  );
}
