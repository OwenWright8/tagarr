import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, EyeOff, Inbox, Link2Off, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api, get, type RequestEntry, type SettingsData } from "@/lib/api";
import { PageHeader, useOverview } from "@/components/Layout";
import { Avatar, Poster, usePeople } from "@/components/people";
import { Badge, Button, EmptyState, PageSpinner, Segmented, timeAgo } from "@/components/ui";

const STATE: Record<RequestEntry["state"], { label: string; tone: "success" | "warning" | "neutral" | "danger" | "primary"; icon: React.ReactNode }> = {
  tagged: { label: "Tagged", tone: "success", icon: <CheckCircle2 className="h-3 w-3" /> },
  queued: { label: "Tagging next sync", tone: "primary", icon: <Clock className="h-3 w-3" /> },
  waiting: { label: "Not in Jellyfin yet", tone: "neutral", icon: <Clock className="h-3 w-3" /> },
  unlinked: { label: "Requester not linked", tone: "warning", icon: <Link2Off className="h-3 w-3" /> },
  ignored: { label: "Not tagged (ignored user)", tone: "neutral", icon: <EyeOff className="h-3 w-3" /> },
  declined: { label: "Declined", tone: "danger", icon: <XCircle className="h-3 w-3" /> },
};

export default function RequestsPage() {
  const overview = useOverview();
  const people = usePeople();
  const requests = useQuery({ queryKey: ["requests"], queryFn: () => get<RequestEntry[]>("/requests"), refetchInterval: 60_000 });
  const [show, setShow] = useState<"all" | "waiting" | "attention">("all");
  const byId = useMemo(() => new Map((people.data ?? []).map((p) => [p.id, p])), [people.data]);
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => get<SettingsData>("/settings") });
  const ignore = useMutation({
    mutationFn: (ids: number[]) =>
      api("PUT", "/settings", { ignoredSeerrUsers: [...(settings.data?.ignoredSeerrUsers ?? []), ...ids] }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success("Ignored. Their requests won't be tagged. Undo under Settings → People.");
    },
    onError: (err) => toast.error(err.message),
  });

  if (overview.data && !overview.data.connections.seerr) {
    return (
      <div className="animate-fade-in">
        <PageHeader title="Requests" />
        <EmptyState icon={<Inbox className="h-5 w-5" />} title="Seerr isn't connected" action={<Link to="/settings"><Button>Connect Seerr</Button></Link>}>
          Connect Seerr and everything someone requests is tagged with their name once it arrives in Jellyfin.
        </EmptyState>
      </div>
    );
  }
  if (!requests.data) return <PageSpinner />;

  const list = requests.data.filter((r) => (show === "waiting" ? r.state === "waiting" : show === "attention" ? r.state === "unlinked" : true));
  const unlinked = requests.data.filter((r) => r.state === "unlinked");
  const unlinkedNames = [...new Set(unlinked.map((r) => r.requestedBy))];
  const unlinkedIds = [...new Set(unlinked.map((r) => r.seerrUserId).filter((id): id is number => id != null))];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Requests"
        description="Everything requested in Seerr. Each one is tagged with the requester once it's in Jellyfin, and only once: take a tag off and it stays off."
      />

      {unlinkedNames.length > 0 && (
        <div className="mb-5 flex flex-col gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm sm:flex-row sm:items-center">
          <Link2Off className="h-4 w-4 shrink-0 text-warning" />
          <span className="flex-1">
            <strong>{unlinkedNames.join(", ")}</strong> {unlinkedNames.length === 1 ? "isn't" : "aren't"} linked to a person, so {unlinked.length} request
            {unlinked.length === 1 ? " is" : "s are"} waiting for a tag.
          </span>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => ignore.mutate(unlinkedIds)} loading={ignore.isPending}>
              <EyeOff className="h-3.5 w-3.5" /> Ignore {unlinkedNames.length === 1 ? unlinkedNames[0] : "them"}
            </Button>
            <Link to="/settings#people" className="font-medium text-primary hover:underline">
              Link in Settings →
            </Link>
          </div>
        </div>
      )}

      <div className="mb-4">
        <Segmented
          value={show}
          onChange={setShow}
          options={[
            { value: "all", label: `All ${requests.data.length}` },
            { value: "waiting", label: "Not in Jellyfin yet" },
            { value: "attention", label: "Needs linking" },
          ]}
        />
      </div>

      {list.length === 0 ? (
        <EmptyState icon={<Inbox className="h-5 w-5" />} title="No requests here" />
      ) : (
        <div className="divide-y rounded-xl border bg-card">
          {list.map((r) => {
            const person = r.personId != null ? byId.get(r.personId) : undefined;
            const st = STATE[r.state];
            return (
              <div key={r.id} className="flex items-center gap-3 px-3 py-3 sm:px-4">
                {r.itemId ? (
                  <Poster itemId={r.itemId} hasImage={r.hasImage} name="" type={r.type} className="h-14 w-10 shrink-0 rounded-md" />
                ) : (
                  <div className="flex h-14 w-10 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground">
                    <Clock className="h-4 w-4" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {r.title} {r.year && <span className="font-normal text-muted-foreground">({r.year})</span>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    {person ? <Avatar person={person} size="xs" /> : null}
                    <span>
                      {r.requestedBy ?? "Unknown"} · {r.type === "tv" ? "Show" : "Movie"} · {timeAgo(r.createdAt)}
                    </span>
                  </div>
                </div>
                <Badge tone={st.tone} className="shrink-0">
                  {st.icon}
                  <span className="hidden sm:inline">{st.label}</span>
                </Badge>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
