import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, CircleDashed, Clock, Film, Inbox, Sparkles, Tag, Tags, Tv, UserX, Users } from "lucide-react";
import { PageHeader, useOverview } from "@/components/Layout";
import { Avatar } from "@/components/people";
import { ActivityList } from "@/pages/Activity";
import { Card, CardBody, CardHeader, PageSpinner, cn, timeAgo } from "@/components/ui";

export default function OverviewPage() {
  const overview = useOverview();
  if (!overview.data) return <PageSpinner />;
  const { totals, people, activity, sync, connections } = overview.data;
  const tagged = totals.items - totals.untagged;
  const pct = totals.items ? Math.round((tagged / totals.items) * 100) : 0;
  const maxCount = Math.max(1, ...people.map((p) => p.count));

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Overview"
        description={
          <>
            {totals.items} titles in Jellyfin · {totals.movies} movies, {totals.shows} shows
            {sync.finishedAt && <> · synced {timeAgo(sync.finishedAt)}</>}
          </>
        }
      />

      {!connections.seerr && (
        <Callout tone="info" icon={<Inbox className="h-4 w-4" />} to="/settings" action="Connect Seerr">
          Seerr isn't connected, so new requests aren't tagged automatically.
        </Callout>
      )}
      {sync.ok === false && (
        <Callout tone="danger" icon={<AlertTriangle className="h-4 w-4" />} to="/activity" action="See activity">
          The last sync had problems{sync.error ? `: ${sync.error}` : "."}
        </Callout>
      )}

      {/* Headline tiles */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Tile
          to="/library?filter=untagged"
          icon={<CircleDashed className="h-4 w-4" />}
          label="Untagged"
          value={totals.untagged}
          hint={totals.untagged ? "Nobody can see these yet" : "Everything has an owner"}
          highlight={totals.untagged > 0}
        />
        <Tile to="/library?filter=shared" icon={<Tags className="h-4 w-4" />} label="Shared" value={totals.shared} hint="Tagged for 2+ people" />
        <Tile to="/requests" icon={<Clock className="h-4 w-4" />} label="Waiting" value={totals.pendingRequests} hint="Requested, not in Jellyfin yet" />
        <Tile
          to="/suggestions"
          icon={<Sparkles className="h-4 w-4" />}
          label="Suggestions"
          value={totals.suggestions}
          hint="From watch history"
          highlight={totals.suggestions > 0}
        />
      </div>

      <div className="mt-4 grid gap-4 sm:mt-6 sm:gap-6 lg:grid-cols-5">
        {/* People */}
        <Card className="lg:col-span-3">
          <CardHeader
            icon={<Users className="h-5 w-5" />}
            title="People"
            description={`${pct}% of the library is tagged`}
            action={
              <Link to="/settings#people" className="text-sm font-medium text-primary hover:underline">
                Manage
              </Link>
            }
          />
          <CardBody>
            <div className="mb-5 h-2.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            {people.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No people yet. <Link to="/settings#people" className="font-medium text-primary hover:underline">Add someone</Link> to start tagging.
              </p>
            ) : (
              <ul className="space-y-3.5">
                {people.map((p) => (
                  <li key={p.id}>
                    <Link to={`/library?filter=person:${p.id}`} className="group flex items-center gap-3">
                      <Avatar person={p} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2 text-sm">
                          <span className="font-medium group-hover:underline">{p.name}</span>
                          <span className="tabular-nums text-muted-foreground">
                            {p.count} <span className="hidden sm:inline">· {p.onlyCount} only theirs</span>
                          </span>
                        </div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full" style={{ width: `${(p.count / maxCount) * 100}%`, backgroundColor: p.color }} />
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {totals.unmappedRequests > 0 && (
              <Link to="/requests" className="mt-5 flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning hover:bg-warning/15">
                <UserX className="h-4 w-4 shrink-0" />
                <span className="flex-1">
                  {totals.unmappedRequests} request{totals.unmappedRequests === 1 ? "" : "s"} from a Seerr user who isn't linked to anyone
                </span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            )}
          </CardBody>
        </Card>

        {/* Library split */}
        <Card className="lg:col-span-2">
          <CardHeader icon={<Tag className="h-5 w-5" />} title="Library" />
          <CardBody className="space-y-3">
            <Split icon={<Film className="h-4 w-4" />} label="Movies" value={totals.movies} to="/library?type=Movie" />
            <Split icon={<Tv className="h-4 w-4" />} label="Shows" value={totals.shows} to="/library?type=Series" />
            <Split icon={<CircleDashed className="h-4 w-4" />} label="Untagged" value={totals.untagged} to="/library?filter=untagged" warn={totals.untagged > 0} />
            <Split icon={<Tags className="h-4 w-4" />} label="Shared" value={totals.shared} to="/library?filter=shared" />
          </CardBody>
        </Card>
      </div>

      <Card className="mt-4 sm:mt-6">
        <CardHeader
          title="Recent activity"
          action={
            <Link to="/activity" className="text-sm font-medium text-primary hover:underline">
              All activity
            </Link>
          }
        />
        <CardBody className="pt-3 sm:pt-4">
          <ActivityList entries={activity} empty="Nothing yet. Tags written, requests matched and errors show up here." />
        </CardBody>
      </Card>
    </div>
  );
}

function Tile({ to, icon, label, value, hint, highlight }: { to: string; icon: React.ReactNode; label: string; value: number; hint: string; highlight?: boolean }) {
  return (
    <Link
      to={to}
      className={cn(
        "group rounded-xl border bg-card p-4 shadow-sm transition-all hover:-translate-y-px hover:shadow-md sm:p-5",
        highlight && "border-primary/30 bg-primary-soft/40",
      )}
    >
      <div className={cn("flex items-center gap-2 text-[13px] font-medium", highlight ? "text-primary" : "text-muted-foreground")}>
        {icon}
        {label}
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </Link>
  );
}

function Split({ icon, label, value, to, warn }: { icon: React.ReactNode; label: string; value: number; to: string; warn?: boolean }) {
  return (
    <Link to={to} className="flex items-center gap-3 rounded-lg px-1 py-1 text-sm hover:bg-muted">
      <span className={cn("rounded-md p-1.5", warn ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground")}>{icon}</span>
      <span className="flex-1">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </Link>
  );
}

function Callout({ tone, icon, children, to, action }: { tone: "info" | "danger"; icon: React.ReactNode; children: React.ReactNode; to: string; action: string }) {
  return (
    <div
      className={cn(
        "mb-4 flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center",
        tone === "danger" ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-primary/20 bg-primary-soft/50 text-foreground",
      )}
    >
      <span className="flex flex-1 items-start gap-2">
        <span className="mt-0.5">{icon}</span>
        {children}
      </span>
      <Link to={to} className="font-medium text-primary hover:underline">
        {action} →
      </Link>
    </div>
  );
}
