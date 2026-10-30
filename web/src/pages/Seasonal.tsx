import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarRange, Check, Film, ImagePlus, Library as LibraryIcon, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { ApiError, api, get, type Item, type Person, type Season, type SeasonDetail } from "@/lib/api";
import { PageHeader } from "@/components/Layout";
import { Avatar, AvatarStack, Poster, usePeople } from "@/components/people";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageSpinner, Spinner, Switch, cn } from "@/components/ui";

export function useSeasons() {
  return useQuery({ queryKey: ["seasons"], queryFn: () => get<Season[]>("/seasons"), refetchInterval: 60_000 });
}

/** "2026-10-01T00:00" as the wall-clock time it names (the server's time zone). */
function wall(s: string) {
  const [d, t = "00:00"] = s.split("T");
  const [y, mo, day] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  return new Date(y, mo - 1, day, h, mi);
}

export function formatWall(s: string, withYear: boolean) {
  const d = wall(s);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });
  const midnight = d.getHours() === 0 && d.getMinutes() === 0;
  return midnight ? date : `${date}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function fromNow(iso: string) {
  const ms = Date.parse(iso) - Date.now();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "in a moment";
  if (min < 60) return `in ${min} min`;
  const h = Math.round(min / 60);
  if (h < 36) return `in ${h} h`;
  const days = Math.round(h / 24);
  if (days < 60) return `in ${days} days`;
  return `in ${Math.round(days / 30)} months`;
}

export function SeasonBadge({ season }: { season: Season }) {
  const st = season.status;
  if (st.active) return <Badge tone="success">In season · ends {fromNow(st.end)}</Badge>;
  if (st.over) return <Badge>Over</Badge>;
  return <Badge>Starts {fromNow(st.start)}</Badge>;
}

export default function SeasonalPage() {
  const seasons = useSeasons();
  const people = usePeople();
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [deleting, setDeleting] = useState<Season | null>(null);

  if (!seasons.data || !people.data) return <PageSpinner />;
  const byId = new Map(people.data.map((p) => [p.id, p]));

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Seasonal"
        description="Titles that only show at a certain time of year, like Halloween movies in October. In season they're tagged for the people you pick; the rest of the year they carry nobody's tag, so nobody with a tag rule sees them."
        actions={
          seasons.data.length > 0 && (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" /> New season
            </Button>
          )
        }
      />

      {seasons.data.length === 0 ? (
        <EmptyState
          icon={<CalendarRange className="h-5 w-5" />}
          title="No seasons yet"
          action={
            <Button onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" /> New season
            </Button>
          }
        >
          Make a Halloween season, pick the spooky movies and who gets them, and they'll appear on Oct 1 and disappear on Nov 1, every year. It can keep a Jellyfin collection too, which hides along with them.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {seasons.data.map((s) => {
            const who = s.people.map((id) => byId.get(id)).filter((p): p is Person => !!p);
            return (
              <Card key={s.id} className="p-4 sm:p-5">
                <div className="flex items-start gap-4">
                  {s.coverVersion ? (
                    <img src={coverUrl(s.id, s.coverVersion)} alt="" className="hidden h-[66px] w-11 shrink-0 rounded-lg object-cover shadow-sm sm:block" />
                  ) : (
                    <div className={cn("hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl sm:flex", s.status.active ? "bg-success/10 text-success" : "bg-muted text-muted-foreground")}>
                      <CalendarRange className="h-5 w-5" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold">{s.name}</h2>
                      <SeasonBadge season={s} />
                      {!s.applied && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Spinner className="h-3 w-3" /> Updating Jellyfin
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {formatWall(s.start, !s.yearly)} → {formatWall(s.end, !s.yearly)} · {s.yearly ? "every year" : "once"}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
                      <span className="flex items-center gap-2">
                        <span className="text-muted-foreground">Shows for</span>
                        {who.length ? (
                          <>
                            <AvatarStack people={who} />
                            <span className="font-medium">{who.map((p) => p.name).join(", ")}</span>
                          </>
                        ) : (
                          <span className="font-medium">nobody</span>
                        )}
                      </span>
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <Film className="h-3.5 w-3.5" /> {s.itemCount} title{s.itemCount === 1 ? "" : "s"}
                        {s.missingCount > 0 && (
                          <span title="Not in Jellyfin right now (being replaced or re-downloaded?). They rejoin the season when they're back.">
                            {" "}
                            (+{s.missingCount} not in Jellyfin)
                          </span>
                        )}
                      </span>
                      {s.collection && (
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <LibraryIcon className="h-3.5 w-3.5" /> Collection “{s.collectionName || s.name}”
                          {!s.collectionMade && s.itemCount > 0 && " (made on the next sync)"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon" onClick={() => setEditing(s.id)} aria-label={`Edit ${s.name}`}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDeleting(s)} aria-label={`Delete ${s.name}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
          <p className="pt-2 text-xs leading-relaxed text-muted-foreground">
            While a title is in a season, the season decides who sees it. Take it out of the season and it goes back to whoever it belonged to. Dates use the Tagarr
            server's time zone (the TZ setting).
          </p>
        </div>
      )}

      {editing !== null && <SeasonEditor id={editing === "new" ? null : editing} people={people.data} onClose={() => setEditing(null)} />}
      {deleting && <DeleteSeason season={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

const coverUrl = (id: number, version: number) => `/api/seasons/${id}/cover?v=${version}`;
const COVER_TYPES = ["image/jpeg", "image/png", "image/webp"];

async function uploadCover(id: number, file: File) {
  const res = await fetch(`/api/seasons/${id}/cover`, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": file.type }, body: file });
  if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't upload the cover");
}

const PRESETS: { name: string; start: string; end: string }[] = [
  { name: "Halloween", start: "10-01", end: "11-01" },
  { name: "Christmas", start: "12-01", end: "12-27" },
  { name: "Valentine's", start: "02-01", end: "02-15" },
  { name: "Summer", start: "06-01", end: "09-01" },
];

type PickedItem = SeasonDetail["items"][number];

function SeasonEditor({ id, people, onClose }: { id: number | null; people: Person[]; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["season", id], queryFn: () => get<SeasonDetail>(`/seasons/${id}`), enabled: id !== null });
  const year = new Date().getFullYear();
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState(`${year}-10-01`);
  const [startTime, setStartTime] = useState("00:00");
  const [endDate, setEndDate] = useState(`${year}-11-01`);
  const [endTime, setEndTime] = useState("00:00");
  const [yearly, setYearly] = useState(true);
  const [who, setWho] = useState<Set<number>>(() => new Set(people.map((p) => p.id)));
  const [items, setItems] = useState<Map<string, PickedItem>>(new Map());
  const [collection, setCollection] = useState(true);
  const [collectionName, setCollectionName] = useState("");
  const [generic, setGeneric] = useState(true);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverRemoved, setCoverRemoved] = useState(false);
  const coverPreview = useMemo(() => (coverFile ? URL.createObjectURL(coverFile) : null), [coverFile]);
  useEffect(() => () => void (coverPreview && URL.revokeObjectURL(coverPreview)), [coverPreview]);
  const savedCover = id !== null && detail.data?.coverVersion && !coverRemoved ? coverUrl(id, detail.data.coverVersion) : null;
  const [loaded, setLoaded] = useState(id === null);

  useEffect(() => {
    const d = detail.data;
    if (!d || loaded) return;
    setName(d.name);
    [setStartDate, setStartTime].forEach((f, i) => f(d.start.split("T")[i]));
    [setEndDate, setEndTime].forEach((f, i) => f(d.end.split("T")[i]));
    setYearly(d.yearly);
    setWho(new Set(d.people));
    setItems(new Map(d.items.map((i) => [i.id, i])));
    setCollection(d.collection);
    setCollectionName(d.collectionName ?? "");
    setGeneric(d.collectionGeneric);
    setLoaded(true);
  }, [detail.data, loaded]);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name,
        start: `${startDate}T${startTime || "00:00"}`,
        end: `${endDate}T${endTime || "00:00"}`,
        yearly,
        people: [...who],
        itemIds: [...items.keys()],
        collection,
        collectionName: collectionName.trim() || null,
        collectionGeneric: generic,
      };
      const saved = id === null ? await api<{ id: number }>("POST", "/seasons", body) : (await api("PATCH", `/seasons/${id}`, body), { id });
      if (coverFile) await uploadCover(saved.id, coverFile);
      else if (coverRemoved && detail.data?.coverVersion) await api("DELETE", `/seasons/${saved.id}/cover`);
    },
    onSuccess: () => {
      toast.success(id === null ? `${name} added. Jellyfin updates in a few seconds.` : "Saved. Jellyfin updates in a few seconds.");
      qc.invalidateQueries();
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setName(p.name);
    const endYear = p.end < p.start ? year + 1 : year;
    setStartDate(`${year}-${p.start}`);
    setEndDate(`${endYear}-${p.end}`);
    setStartTime("00:00");
    setEndTime("00:00");
    setYearly(true);
  };

  const toggleItem = (item: PickedItem) =>
    setItems((m) => {
      const next = new Map(m);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={id === null ? "New season" : `Edit ${detail.data?.name ?? "season"}`}
      description="In season, these titles are tagged for the people you pick. The rest of the time they're hidden."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!loaded || !name.trim()}>
            {id === null ? "Add season" : "Save"}
          </Button>
        </>
      }
    >
      {!loaded ? (
        <PageSpinner />
      ) : (
        <div className="space-y-5 pb-2">
          {id === null && (
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-[13px] font-medium transition-colors",
                    name === p.name ? "border-primary bg-primary-soft text-primary" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}

          <Field label="Name" htmlFor="season-name">
            <Input id="season-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Halloween" maxLength={100} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Starts">
              <div className="flex gap-2">
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-label="Start date" />
                <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="w-32" aria-label="Start time" />
              </div>
            </Field>
            <Field label="Ends (hidden again)">
              <div className="flex gap-2">
                <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} aria-label="End date" />
                <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="w-32" aria-label="End time" />
              </div>
            </Field>
          </div>
          <label className="flex items-center justify-between gap-4 rounded-xl border px-4 py-3">
            <span>
              <span className="block text-sm font-medium">Every year</span>
              <span className="block text-xs text-muted-foreground">
                {yearly ? "The year is ignored, so it comes back each year. It can run past New Year (Dec 20 → Jan 6)." : "Runs once, on exactly these dates."}
              </span>
            </span>
            <Switch checked={yearly} onChange={setYearly} label="Every year" />
          </label>

          <Field label="Who sees it in season" hint="Out of season nobody does (except accounts without a tag rule, like an admin).">
            <div className="flex flex-wrap gap-2">
              {people.map((p) => {
                const on = who.has(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setWho((s) => {
                        const next = new Set(s);
                        if (on) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      })
                    }
                    className={cn("inline-flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-[13px] font-medium transition-colors", !on && "opacity-60 hover:opacity-100")}
                    style={on ? { backgroundColor: `${p.color}1f`, borderColor: `${p.color}66`, color: p.color } : undefined}
                  >
                    <Avatar person={p} size="sm" />
                    {p.name}
                    {on && <Check className="h-3.5 w-3.5" />}
                  </button>
                );
              })}
            </div>
          </Field>

          <TitlePicker picked={items} onToggle={toggleItem} />

          <div className="space-y-3 rounded-xl border px-4 py-3">
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">Keep a Jellyfin collection</span>
                <span className="block text-xs text-muted-foreground">
                  Tagarr keeps it holding exactly these titles, and tags it like them, so it disappears out of season instead of sitting there empty.
                </span>
              </span>
              <Switch checked={collection} onChange={setCollection} label="Keep a Jellyfin collection" />
            </label>
            {collection && (
              <Field
                label="Collection name"
                hint={
                  id !== null && detail.data?.collectionMade
                    ? "Turning this off deletes the collection Tagarr made."
                    : "If a collection with this name already exists, Tagarr takes it over."
                }
              >
                <Input value={collectionName} onChange={(e) => setCollectionName(e.target.value)} placeholder={name || "Halloween"} maxLength={100} />
              </Field>
            )}
            {collection && (
              <CoverPicker
                preview={coverPreview ?? savedCover}
                onPick={(f) => {
                  setCoverFile(f);
                  setCoverRemoved(false);
                }}
                onRemove={() => {
                  setCoverFile(null);
                  setCoverRemoved(true);
                }}
              />
            )}
            {collection && (
              <label className="flex items-center justify-between gap-4 border-t pt-3">
                <span>
                  <span className="block text-sm font-medium">Don't match it online</span>
                  <span className="block text-xs text-muted-foreground">
                    Stops Jellyfin turning a “{collectionName.trim() || name || "Halloween"}” collection into the film series with the same name. Tagarr clears that
                    match and locks the collection; its poster becomes a collage of its titles. Turn off only to use a real film series' collection.
                  </span>
                </span>
                <Switch checked={generic} onChange={setGeneric} label="Don't match it online" />
              </label>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function CoverPicker({ preview, onPick, onRemove }: { preview: string | null; onPick: (f: File) => void; onRemove: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-4 border-t pt-3">
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="flex h-[90px] w-[60px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed bg-muted/50 text-muted-foreground hover:bg-muted"
        aria-label="Choose a cover image"
      >
        {preview ? <img src={preview} alt="" className="h-full w-full object-cover" /> : <ImagePlus className="h-5 w-5" />}
      </button>
      <div className="min-w-0 flex-1">
        <span className="block text-sm font-medium">Cover</span>
        <span className="block text-xs text-muted-foreground">
          The collection's poster in Jellyfin. JPEG, PNG or WebP up to 10 MB, ideally tall like a movie poster (2:3). Without one, Jellyfin makes a collage of the titles.
        </span>
        <div className="mt-2 flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
            {preview ? "Replace" : "Upload image"}
          </Button>
          {preview && (
            <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept={COVER_TYPES.join(",")}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          if (!COVER_TYPES.includes(f.type)) return void toast.error("Use a JPEG, PNG or WebP image");
          if (f.size > 10 * 1024 * 1024) return void toast.error("That image is over 10 MB");
          onPick(f);
        }}
      />
    </div>
  );
}

function TitlePicker({ picked, onToggle }: { picked: Map<string, PickedItem>; onToggle: (item: PickedItem) => void }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const results = useQuery({
    queryKey: ["season-search", debounced],
    queryFn: () => get<{ items: Item[] }>(`/items?${new URLSearchParams({ q: debounced, sort: "name", limit: "30" })}`),
    enabled: debounced.length > 0,
  });
  const list = [...picked.values()].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm font-medium">Titles</span>
        <span className="text-xs text-muted-foreground">{picked.size} picked</span>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your library to add titles" className="pl-9" type="search" />
      </div>
      {debounced && (
        <div className="mt-2 max-h-56 divide-y overflow-y-auto rounded-xl border">
          {results.isLoading ? (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          ) : !results.data?.items.length ? (
            <p className="px-3 py-4 text-center text-sm text-muted-foreground">No titles match “{debounced}”.</p>
          ) : (
            results.data.items.map((i) => {
              const on = picked.has(i.id);
              return (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => onToggle(i)}
                  className={cn("flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted", on && "bg-primary-soft/50")}
                >
                  <Poster itemId={i.id} hasImage={i.hasImage} name="" type={i.type} className="h-10 w-7 shrink-0 rounded" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{i.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {i.year ?? "—"} · {i.type === "Series" ? "Show" : "Movie"}
                      {i.seasons.length > 0 && ` · in ${i.seasons.map((s) => s.name).join(", ")}`}
                    </span>
                  </span>
                  <span className={cn("flex h-6 w-6 items-center justify-center rounded-full border", on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground")}>
                    {on ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
      {list.length > 0 ? (
        <div className="mt-3 flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
          {list.map((i) => (
            <span key={i.id} className="inline-flex items-center gap-1.5 rounded-lg border bg-card py-0.5 pl-0.5 pr-1 text-[13px]">
              <Poster itemId={i.id} hasImage={i.hasImage} name="" type={i.type} className="h-7 w-5 shrink-0 rounded" />
              <span className="max-w-[12rem] truncate">{i.name}</span>
              <button type="button" onClick={() => onToggle(i)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Remove ${i.name}`}>
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">You can also select titles in the Library and add them to a season from there.</p>
      )}
    </div>
  );
}

function DeleteSeason({ season, onClose }: { season: Season; onClose: () => void }) {
  const qc = useQueryClient();
  const [keep, setKeep] = useState(false);
  const del = useMutation({
    mutationFn: () => api("DELETE", `/seasons/${season.id}${keep ? "?keepCollection=1" : ""}`),
    onSuccess: () => {
      toast.success(`Removed ${season.name}`);
      qc.invalidateQueries();
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Delete ${season.name}?`}
      description={`Its ${season.itemCount} title${season.itemCount === 1 ? "" : "s"} go back to whoever they belonged to before, all year round.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => del.mutate()} loading={del.isPending}>
            Delete season
          </Button>
        </>
      }
    >
      {season.collectionMade ? (
        <label className="flex items-center justify-between gap-4 pb-2 text-sm">
          <span>Keep the “{season.collectionName || season.name}” collection in Jellyfin</span>
          <Switch checked={keep} onChange={setKeep} label="Keep the collection" />
        </label>
      ) : (
        <span />
      )}
    </Modal>
  );
}
