import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOff, Link2, Pencil, Plus, Trash2, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { api, get, type Person, type RemoteUsers, type SettingsData } from "@/lib/api";
import { Avatar, COLORS, usePeople } from "./people";
import { Badge, Button, EmptyState, Field, Input, Modal, Select, Spinner, cn } from "./ui";

export function useRemoteUsers() {
  return useQuery({ queryKey: ["remote-users"], queryFn: () => get<RemoteUsers>("/remote-users"), staleTime: 60_000 });
}

export function PeopleEditor() {
  const qc = useQueryClient();
  const people = usePeople();
  const remote = useRemoteUsers();
  const [editing, setEditing] = useState<Person | "new" | null>(null);
  const [deleting, setDeleting] = useState<Person | null>(null);
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => get<SettingsData>("/settings") });
  const ignoredIds = settings.data?.ignoredSeerrUsers ?? [];
  const setIgnored = useMutation({
    mutationFn: (ids: number[]) => api("PUT", "/settings", { ignoredSeerrUsers: ids }),
    onSuccess: () => qc.invalidateQueries(),
    onError: (err) => toast.error(err.message),
  });

  const add = useMutation({
    mutationFn: (body: Partial<Person>) => api("POST", "/people", body),
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success("Added. Their requests will be tagged on the next sync.");
    },
    onError: (err) => toast.error(err.message),
  });

  // Seerr users nobody is linked to yet, with their Jellyfin account matched.
  const suggestions = useMemo(() => {
    if (!remote.data || !people.data) return [];
    const linked = new Set(people.data.map((p) => p.seerrUserId));
    const tags = new Set(people.data.map((p) => p.tag.toLowerCase()));
    return remote.data.seerr
      .filter((u) => !linked.has(u.id) && !ignoredIds.includes(u.id))
      .map((u) => ({
        ...u,
        jellyfin: remote.data!.jellyfin.find((j) => j.id === u.jellyfinUserId) ?? remote.data!.jellyfin.find((j) => j.name.toLowerCase() === u.name.toLowerCase()),
        // An existing person with the same tag would clash; they can link via Edit instead.
        clash: tags.has(u.name.toLowerCase()),
      }));
  }, [remote.data, people.data, ignoredIds]);

  if (people.isLoading) return <Spinner />;
  const list = people.data ?? [];

  return (
    <div className="space-y-5">
      {list.length === 0 ? (
        <EmptyState icon={<Users className="h-5 w-5" />} title="No people yet">
          Each person is a tag. Add yourself and whoever shares your library{suggestions.length ? ", or pick them from Seerr below" : ""}.
        </EmptyState>
      ) : (
        <ul className="divide-y rounded-xl border">
          {list.map((p) => {
            const seerrName = remote.data?.seerr.find((u) => u.id === p.seerrUserId)?.name;
            const jfName = remote.data?.jellyfin.find((u) => u.id === p.jellyfinUserId)?.name;
            return (
              <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                <Avatar person={p} size="lg" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">{p.name}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{p.tag}</code>
                    {p.count !== undefined && <span className="text-xs text-muted-foreground">{p.count} items</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                    {p.seerrUserId != null ? (
                      <Badge tone="primary">
                        <Link2 className="h-3 w-3" /> Seerr: {seerrName ?? `user ${p.seerrUserId}`}
                      </Badge>
                    ) : (
                      <Badge>No Seerr user</Badge>
                    )}
                    {p.jellyfinUserId ? (
                      <Badge tone="primary">
                        <Link2 className="h-3 w-3" /> Jellyfin: {jfName ?? "linked"}
                      </Badge>
                    ) : (
                      <Badge>No Jellyfin user</Badge>
                    )}
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setDeleting(p)} aria-label={`Remove ${p.name}`}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {suggestions.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">From Seerr</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {suggestions.map((u) => (
              <div key={u.id} className="flex items-center gap-3 rounded-xl border border-dashed px-3.5 py-3">
                <UserPlus className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{u.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {u.requestCount} request{u.requestCount === 1 ? "" : "s"}{u.jellyfin ? ` · Jellyfin “${u.jellyfin.name}”` : ""}
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  title={`Ignore ${u.name}: their requests are never tagged (e.g. an admin who sees everything)`}
                  aria-label={`Ignore ${u.name}`}
                  onClick={() => setIgnored.mutate([...ignoredIds, u.id])}
                >
                  <EyeOff className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={add.isPending && add.variables?.seerrUserId === u.id}
                  onClick={() =>
                    u.clash
                      ? setEditing({ ...(list.find((p) => p.tag.toLowerCase() === u.name.toLowerCase()) as Person), seerrUserId: u.id, jellyfinUserId: u.jellyfin?.id ?? null })
                      : add.mutate({ name: u.name, tag: u.name, seerrUserId: u.id, jellyfinUserId: u.jellyfin?.id ?? null })
                  }
                >
                  {u.clash ? "Link" : "Add"}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      {ignoredIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <EyeOff className="h-4 w-4" />
          <span>Ignored Seerr users (their requests aren't tagged):</span>
          {ignoredIds.map((id) => (
            <span key={id} className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs">
              {remote.data?.seerr.find((u) => u.id === id)?.name ?? `User ${id}`}
              <button
                className="font-medium text-primary hover:underline"
                onClick={() => setIgnored.mutate(ignoredIds.filter((x) => x !== id))}
              >
                Undo
              </button>
            </span>
          ))}
        </div>
      )}
      {remote.data?.errors.map((e) => (
        <p key={e} className="text-sm text-destructive">
          {e}
        </p>
      ))}

      <Button variant="outline" onClick={() => setEditing("new")}>
        <Plus className="h-4 w-4" /> Add a person or tag
      </Button>

      {editing && <PersonModal person={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && <DeletePersonModal person={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function PersonModal({ person, onClose }: { person: Person | null; onClose: () => void }) {
  const qc = useQueryClient();
  const remote = useRemoteUsers();
  const people = usePeople();
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => get<{ tag: string; count: number }[]>("/tags") });
  const used = new Set(people.data?.filter((p) => p.id !== person?.id).map((p) => p.color));
  const [name, setName] = useState(person?.name ?? "");
  const [tag, setTag] = useState(person?.tag ?? "");
  const [tagTouched, setTagTouched] = useState(!!person);
  const [color, setColor] = useState(person?.color ?? COLORS.find((c) => !used.has(c)) ?? COLORS[0]);
  const [seerrUserId, setSeerrUserId] = useState<string>(person?.seerrUserId != null ? String(person.seerrUserId) : "");
  const [jellyfinUserId, setJellyfinUserId] = useState(person?.jellyfinUserId ?? "");

  const save = useMutation({
    mutationFn: () => {
      const body = { name, tag: tag || name, color, seerrUserId: seerrUserId ? Number(seerrUserId) : null, jellyfinUserId: jellyfinUserId || null };
      return person?.id ? api("PATCH", `/people/${person.id}`, body) : api("POST", "/people", body);
    },
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success(person?.id ? "Saved" : "Added");
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  const renaming = person?.id && tag && tag !== person.tag;

  return (
    <Modal
      open
      onClose={onClose}
      title={person?.id ? `Edit ${person.name}` : "Add a person"}
      description="A person is a tag in Jellyfin. Link their Seerr account to tag what they request."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>
            {person?.id ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name" htmlFor="p-name">
          <Input
            id="p-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!tagTouched) setTag(e.target.value);
            }}
            placeholder="Owen"
          />
        </Field>
        <Field
          label="Tag"
          htmlFor="p-tag"
          hint={renaming ? `Renames “${person!.tag}” to “${tag}” on all ${person!.count ?? ""} of their items in Jellyfin.` : "Already using tags? Pick yours and existing items are picked up as they are."}
        >
          <Input
            id="p-tag"
            list="existing-tags"
            value={tag}
            onChange={(e) => {
              setTag(e.target.value);
              setTagTouched(true);
            }}
            placeholder={name || "owen"}
          />
          <datalist id="existing-tags">
            {tags.data?.map((t) => (
              <option key={t.tag} value={t.tag}>
                {t.count} items
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Color">
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={cn("h-8 w-8 rounded-full transition-transform", color === c ? "scale-110 ring-2 ring-foreground ring-offset-2 ring-offset-card" : "hover:scale-105")}
                style={{ backgroundColor: c }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Seerr user" htmlFor="p-seerr" hint="Their requests get this tag.">
            <Select id="p-seerr" value={seerrUserId} onChange={(e) => setSeerrUserId(e.target.value)}>
              <option value="">None</option>
              {remote.data?.seerr.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Jellyfin user" htmlFor="p-jf" hint="For watch-history suggestions and access.">
            <Select id="p-jf" value={jellyfinUserId} onChange={(e) => setJellyfinUserId(e.target.value)}>
              <option value="">None</option>
              {remote.data?.jellyfin.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function DeletePersonModal({ person, onClose }: { person: Person; onClose: () => void }) {
  const qc = useQueryClient();
  const [removeTags, setRemoveTags] = useState(true);
  const del = useMutation({
    mutationFn: () => api("DELETE", `/people/${person.id}${removeTags ? "?removeTags=1" : ""}`),
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success(`Removed ${person.name}`);
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Remove ${person.name}?`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => del.mutate()} loading={del.isPending}>
            Remove
          </Button>
        </>
      }
    >
      <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
        <input type="checkbox" checked={removeTags} onChange={(e) => setRemoveTags(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" />
        <span>
          Also remove the tag <code className="rounded bg-muted px-1">{person.tag}</code> from {person.count ?? "their"} items in Jellyfin.
          <span className="mt-1 block text-xs text-muted-foreground">
            Leave this off to keep the tags in Jellyfin. If {person.name} is added again later, they're picked up again.
          </span>
        </span>
      </label>
    </Modal>
  );
}
