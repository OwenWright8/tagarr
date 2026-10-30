import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Info, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api, get, type AccessUser, type Person, type SettingsData } from "@/lib/api";
import { PageHeader, useOverview } from "@/components/Layout";
import { Avatar, PersonChip, usePeople } from "@/components/people";
import { Badge, Button, Card, EmptyState, Modal, PageSpinner, cn } from "@/components/ui";

interface AccessData {
  version: string | null;
  total: number;
  users: AccessUser[];
}

export default function AccessPage() {
  const access = useQuery({ queryKey: ["access"], queryFn: () => get<AccessData>("/access") });
  const people = usePeople();
  const overview = useOverview();
  const [editing, setEditing] = useState<AccessUser | null>(null);

  if (access.error) return <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="Couldn't read Jellyfin's users">{access.error.message}</EmptyState>;
  if (!access.data || !people.data) return <PageSpinner />;
  const { users, total } = access.data;
  const untagged = overview.data?.totals.untagged ?? 0;
  const oldJellyfin = access.data.version && compareVersion(access.data.version, "10.9.0") < 0;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Access"
        description="Jellyfin's parental controls can limit a user to items with certain tags. Set each person to see only their own tag, and shared items show for everyone tagged on them."
      />

      {oldJellyfin && (
        <div className="mb-5 flex gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          Jellyfin {access.data.version} doesn't support “allow items with tags” (it arrived in 10.9). Use Jellyfin's “block items with tags” instead, or upgrade.
        </div>
      )}
      {untagged > 0 && (
        <div className="mb-5 flex gap-2 rounded-xl border border-primary/20 bg-primary-soft/50 px-4 py-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>
            {untagged} title{untagged === 1 ? " is" : "s are"} untagged. A user limited to their tag won't see {untagged === 1 ? "it" : "them"}, so tag them first (or turn on
            the unrequested rule in Settings).
          </span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {users.map((u) => {
          const person = people.data!.find((p) => p.id === u.personId);
          const restricted = u.allowedTags.length > 0;
          return (
            <Card key={u.id} className="flex flex-col p-5">
              <div className="flex items-start gap-3">
                {person ? (
                  <Avatar person={person} size="lg" />
                ) : (
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">{u.name[0]?.toUpperCase()}</span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold">{u.name}</h2>
                    {u.isAdmin && <Badge>Admin</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">{person ? `Linked to ${person.name}` : "Not linked to a person"}</p>
                </div>
                {restricted ? <EyeOff className="h-5 w-5 text-primary" /> : <Eye className="h-5 w-5 text-muted-foreground" />}
              </div>

              <div className="mt-4 rounded-lg bg-muted/60 p-3 text-sm">
                {restricted ? (
                  <>
                    Sees items tagged{" "}
                    {u.allowedTags.map((t, i) => (
                      <span key={t}>
                        {i > 0 && " or "}
                        <code className="rounded bg-card px-1.5 py-0.5 text-xs">{t}</code>
                      </span>
                    ))}
                  </>
                ) : (
                  <>
                    Sees everything (no tag restriction)
                    {person && !u.isAdmin && u.meantToSeeAll && <RemindAgain userId={u.id} />}
                  </>
                )}
                {u.blockedTags.length > 0 && (
                  <div className="mt-1.5 text-xs text-muted-foreground">Blocked in Jellyfin: {u.blockedTags.join(", ")}</div>
                )}
                <div className="mt-2.5">
                  <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                    <span>Visible</span>
                    <span className="tabular-nums">
                      {u.visible} of {total}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-card">
                    <div className="h-full rounded-full" style={{ width: `${total ? (u.visible / total) * 100 : 0}%`, backgroundColor: person?.color ?? "hsl(var(--muted-foreground))" }} />
                  </div>
                </div>
              </div>

              <div className="mt-4 flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setEditing(u)}>
                  Change
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      {editing && <AccessModal user={editing} people={people.data} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AccessModal({ user, people, onClose }: { user: AccessUser; people: Person[]; onClose: () => void }) {
  const qc = useQueryClient();
  const linked = people.find((p) => p.id === user.personId);
  const initial = user.allowedTags.length ? user.allowedTags : linked ? [linked.tag] : [];
  const [restrict, setRestrict] = useState(user.allowedTags.length > 0 || !!linked);
  const [tags, setTags] = useState<string[]>(initial);
  const save = useMutation({
    mutationFn: () => api("POST", `/access/${user.id}`, { allowedTags: restrict ? tags : [] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["access"] });
      qc.invalidateQueries({ queryKey: ["access-reminders"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
      toast.success(`Updated ${user.name} in Jellyfin`);
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });
  const toggleTag = (tag: string) => setTags((t) => (t.some((x) => x.toLowerCase() === tag.toLowerCase()) ? t.filter((x) => x.toLowerCase() !== tag.toLowerCase()) : [...t, tag]));

  return (
    <Modal
      open
      onClose={onClose}
      title={`What can ${user.name} see?`}
      description="This changes the user's parental-control settings in Jellyfin (“Allow items with tags”). Everything else in their profile stays as it is."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={restrict && tags.length === 0}>
            Save to Jellyfin
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Choice active={!restrict} onClick={() => setRestrict(false)} title="Everything" text="No tag restriction." />
        <Choice active={restrict} onClick={() => setRestrict(true)} title="Only items tagged for…" text="Pick whose items this user sees. Items tagged for several people show for each of them." />
        {restrict && (
          <div className="flex flex-wrap gap-2 pl-1 pt-1">
            {people.map((p) => {
              const on = tags.some((t) => t.toLowerCase() === p.tag.toLowerCase());
              return (
                <button key={p.id} onClick={() => toggleTag(p.tag)} className={cn("rounded-full transition-opacity", !on && "opacity-50 hover:opacity-80")}>
                  <PersonChip person={p} muted={!on} />
                </button>
              );
            })}
          </div>
        )}
        {user.isAdmin && restrict && <p className="text-xs text-muted-foreground">Heads up: this is an administrator. The restriction applies to their library views too.</p>}
      </div>
    </Modal>
  );
}

function Choice({ active, onClick, title, text }: { active: boolean; onClick: () => void; title: string; text: string }) {
  return (
    <button onClick={onClick} className={cn("flex w-full gap-3 rounded-xl border p-3.5 text-left transition-colors", active ? "border-primary bg-primary-soft/50" : "hover:bg-muted")}>
      <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2", active ? "border-primary" : "border-input")}>
        {active && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{text}</span>
      </span>
    </button>
  );
}

function compareVersion(a: string, b: string) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Undoes "they're meant to see everything" from the Overview reminder. */
function RemindAgain({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => get<SettingsData>("/settings") });
  const undo = useMutation({
    mutationFn: () =>
      api("PUT", "/settings", { accessReminderDismissed: (settings.data?.accessReminderDismissed ?? []).filter((id) => id !== userId) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["access"] });
      qc.invalidateQueries({ queryKey: ["access-reminders"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  return (
    <span className="text-muted-foreground">
      {" "}
      · on purpose.{" "}
      <button onClick={() => undo.mutate()} disabled={!settings.data || undo.isPending} className="font-medium text-primary hover:underline">
        Remind me again
      </button>
    </span>
  );
}
