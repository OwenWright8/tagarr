import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, CheckSquare, CircleDashed, LayoutGrid, List, Minus, Plus, Search, Sparkles, Square, Tags, X } from "lucide-react";
import { toast } from "sonner";
import { api, get, type Item, type Person } from "@/lib/api";
import { PageHeader, useOverview } from "@/components/Layout";
import { Avatar, Poster, usePeople } from "@/components/people";
import { Badge, Button, EmptyState, Input, Modal, PageSpinner, Segmented, Select, cn } from "@/components/ui";

const PAGE = 120;

const SOURCE_LABEL: Record<string, string> = {
  request: "Requested in Seerr",
  manual: "Tagged by hand",
  jellyfin: "Tag already in Jellyfin",
  watched: "From watch history",
  rule: "Unrequested rule",
};

export function useTagMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { itemIds: string[]; add?: number[]; remove?: number[] }) =>
      api<{ ok: number; failed: { id: string; error: string }[] }>("POST", "/items/tags", body),
    onSuccess: (res) => {
      if (res.failed.length) toast.error(`${res.failed.length} couldn't be changed: ${res.failed[0].error}`);
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      qc.invalidateQueries({ queryKey: ["suggestions"] });
      qc.invalidateQueries({ queryKey: ["people"] });
    },
    onError: (err) => toast.error(err.message),
  });
}

export default function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const filter = params.get("filter") ?? "all";
  const type = params.get("type") ?? "";
  const sort = params.get("sort") ?? "added";
  const [q, setQ] = useState(params.get("q") ?? "");
  const [debouncedQ, setDebouncedQ] = useState(q);
  const [view, setView] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem("tagarr-view") === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [open, setOpen] = useState<Item | null>(null);
  const people = usePeople();
  const overview = useOverview();
  const tagMut = useTagMutation();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all" && !(key === "sort" && value === "added")) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setSelected(new Set());
  };

  const query = useInfiniteQuery({
    queryKey: ["items", filter, type, debouncedQ, sort],
    queryFn: ({ pageParam }) =>
      get<{ total: number; items: Item[] }>(
        `/items?${new URLSearchParams({ filter, type, q: debouncedQ, sort, offset: String(pageParam), limit: String(PAGE) })}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });

  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? 0;
  const byId = useMemo(() => new Map((people.data ?? []).map((p) => [p.id, p])), [people.data]);
  const current = open ? (items.find((i) => i.id === open.id) ?? open) : null;

  const toggle = (item: Item, person: Person) => {
    const has = item.people.some((p) => p.id === person.id);
    tagMut.mutate({ itemIds: [item.id], ...(has ? { remove: [person.id] } : { add: [person.id] }) });
  };

  const toggleSelect = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setViewMode = (v: "grid" | "list") => {
    setView(v);
    try {
      localStorage.setItem("tagarr-view", v);
    } catch {
      // Not remembered.
    }
  };

  const filters: { value: string; label: React.ReactNode; count?: number }[] = [
    { value: "all", label: "All", count: overview.data?.totals.items },
    { value: "untagged", label: <><CircleDashed className="h-3.5 w-3.5" /> Untagged</>, count: overview.data?.totals.untagged },
    { value: "shared", label: <><Tags className="h-3.5 w-3.5" /> Shared</>, count: overview.data?.totals.shared },
    ...(overview.data?.totals.suggestions ? [{ value: "suggested", label: <><Sparkles className="h-3.5 w-3.5" /> Suggested</> }] : []),
    ...(people.data ?? []).map((p) => ({
      value: `person:${p.id}`,
      label: (
        <>
          <Avatar person={p} size="xs" /> {p.name}
        </>
      ),
      count: p.count,
    })),
  ];

  const selecting_ = selecting || selected.size > 0;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Library"
        description="Click a person's face under a title to tag or untag it for them. Select several to tag in bulk."
        actions={
          <Button variant={selecting_ ? "secondary" : "outline"} size="sm" onClick={() => (selecting_ ? (setSelecting(false), setSelected(new Set())) : setSelecting(true))}>
            {selecting_ ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />}
            {selecting_ ? "Done selecting" : "Select"}
          </Button>
        }
      />

      {/* Filters */}
      <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:mx-0 sm:flex-wrap sm:px-0">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => set("filter", f.value)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors",
              filter === f.value ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground",
            )}
          >
            {f.label}
            {f.count !== undefined && <span className={cn("tabular-nums", filter === f.value ? "opacity-80" : "opacity-60")}>{f.count}</span>}
          </button>
        ))}
      </div>

      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles" className="pl-9" type="search" />
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            value={(type || "all") as "all" | "Movie" | "Series"}
            onChange={(v) => set("type", v)}
            options={[
              { value: "all", label: "All" },
              { value: "Movie", label: "Movies" },
              { value: "Series", label: "Shows" },
            ]}
          />
          <Select value={sort} onChange={(e) => set("sort", e.target.value)} className="h-9 w-auto" aria-label="Sort">
            <option value="added">Recently added</option>
            <option value="name">Name</option>
            <option value="year">Year</option>
          </Select>
          <div className="hidden rounded-lg border bg-muted/60 p-0.5 sm:flex">
            {(["grid", "list"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setViewMode(v)}
                className={cn("rounded-md p-1.5", view === v ? "bg-card shadow-sm" : "text-muted-foreground")}
                aria-label={`${v} view`}
              >
                {v === "grid" ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}
              </button>
            ))}
          </div>
        </div>
      </div>

      {query.isLoading || !people.data ? (
        <PageSpinner />
      ) : items.length === 0 ? (
        <EmptyState icon={filter === "untagged" ? <Check className="h-5 w-5" /> : <Search className="h-5 w-5" />} title={filter === "untagged" ? "Nothing untagged" : "Nothing here"}>
          {filter === "untagged" ? "Every title belongs to someone. Nice." : debouncedQ ? "No titles match that search." : "No titles match this filter."}
        </EmptyState>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between text-[13px] text-muted-foreground">
            <span>
              {total} title{total === 1 ? "" : "s"}
            </span>
            {selecting_ && (
              <button className="font-medium text-primary hover:underline" onClick={() => setSelected(new Set(items.map((i) => i.id)))}>
                Select all {items.length < total ? `${items.length} loaded` : ""}
              </button>
            )}
          </div>
          {view === "grid" ? (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 md:grid-cols-5 xl:grid-cols-6">
              {items.map((item) => (
                <PosterCard
                  key={item.id}
                  item={item}
                  people={people.data!}
                  byId={byId}
                  selecting={selecting_}
                  selected={selected.has(item.id)}
                  onSelect={() => toggleSelect(item.id)}
                  onOpen={() => (selecting_ ? toggleSelect(item.id) : setOpen(item))}
                  onToggle={(p) => toggle(item, p)}
                />
              ))}
            </div>
          ) : (
            <div className="divide-y rounded-xl border bg-card">
              {items.map((item) => (
                <ListRow
                  key={item.id}
                  item={item}
                  people={people.data!}
                  selecting={selecting_}
                  selected={selected.has(item.id)}
                  onSelect={() => toggleSelect(item.id)}
                  onOpen={() => (selecting_ ? toggleSelect(item.id) : setOpen(item))}
                  onToggle={(p) => toggle(item, p)}
                />
              ))}
            </div>
          )}
          {query.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button variant="outline" onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}

      {selected.size > 0 && <BulkBar ids={[...selected]} people={people.data ?? []} onDone={() => setSelected(new Set())} />}
      {current && <ItemModal item={current} people={people.data ?? []} onClose={() => setOpen(null)} onToggle={(p) => toggle(current, p)} />}
    </div>
  );
}

function PersonToggles({ item, people, onToggle, size = "sm" }: { item: Item; people: Person[]; onToggle: (p: Person) => void; size?: "sm" | "md" }) {
  return (
    <div className="flex flex-wrap gap-1">
      {people.map((p) => {
        const on = item.people.some((x) => x.id === p.id);
        const suggested = item.suggested.includes(p.id);
        return (
          <button
            key={p.id}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(p);
            }}
            title={`${on ? "Remove" : "Add"} ${p.name}${suggested && !on ? " (suggested: watched it)" : ""}`}
            aria-label={`${on ? "Remove" : "Add"} ${p.name}`}
            aria-pressed={on}
            className={cn(
              "relative inline-flex items-center justify-center rounded-full font-semibold transition-all",
              size === "sm" ? "h-6 w-6 text-[10px]" : "h-8 w-8 text-xs",
              on ? "text-white shadow-sm" : "border border-dashed bg-transparent text-muted-foreground opacity-60 hover:opacity-100",
              suggested && !on && "opacity-100 ring-2 ring-primary/50",
            )}
            style={on ? { backgroundColor: p.color } : { borderColor: p.color, color: p.color }}
          >
            {p.name.slice(0, 1).toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}

function PosterCard({
  item,
  people,
  selecting,
  selected,
  onSelect,
  onOpen,
  onToggle,
}: {
  item: Item;
  people: Person[];
  byId: Map<number, Person>;
  selecting: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onToggle: (p: Person) => void;
}) {
  const untagged = item.people.length === 0;
  return (
    <div className={cn("group relative overflow-hidden rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-md", selected && "ring-2 ring-primary")}>
      <button onClick={onOpen} className="block w-full text-left">
        <Poster itemId={item.id} hasImage={item.hasImage} name={item.name} type={item.type} className="aspect-[2/3] w-full" />
        {untagged && (
          <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white backdrop-blur">
            Untagged
          </span>
        )}
      </button>
      {selecting && (
        <button onClick={onSelect} className="absolute right-2 top-2 rounded-md bg-black/50 p-0.5 text-white backdrop-blur" aria-label={selected ? "Deselect" : "Select"}>
          {selected ? <CheckSquare className="h-5 w-5" /> : <Square className="h-5 w-5" />}
        </button>
      )}
      <div className="space-y-1.5 p-2 sm:p-2.5">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium leading-tight" title={item.name}>
            {item.name}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {item.year ?? "—"} · {item.type === "Series" ? "Show" : "Movie"}
          </div>
        </div>
        <PersonToggles item={item} people={people} onToggle={onToggle} />
      </div>
    </div>
  );
}

function ListRow({
  item,
  people,
  selecting,
  selected,
  onSelect,
  onOpen,
  onToggle,
}: {
  item: Item;
  people: Person[];
  selecting: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onToggle: (p: Person) => void;
}) {
  return (
    <div className={cn("flex items-center gap-3 px-3 py-2.5", selected && "bg-primary-soft/50")}>
      {selecting && (
        <button onClick={onSelect} className="text-muted-foreground" aria-label={selected ? "Deselect" : "Select"}>
          {selected ? <CheckSquare className="h-5 w-5 text-primary" /> : <Square className="h-5 w-5" />}
        </button>
      )}
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <Poster itemId={item.id} hasImage={item.hasImage} name="" type={item.type} className="h-14 w-10 shrink-0 rounded-md" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{item.name}</div>
          <div className="text-xs text-muted-foreground">
            {item.year ?? "—"} · {item.type === "Series" ? "Show" : "Movie"}
            {item.requestedBy.length > 0 && <> · requested by {item.requestedBy.join(", ")}</>}
          </div>
        </div>
      </button>
      {item.people.length === 0 && <Badge tone="warning">Untagged</Badge>}
      <PersonToggles item={item} people={people} onToggle={onToggle} size="md" />
    </div>
  );
}

function ItemModal({ item, people, onClose, onToggle }: { item: Item; people: Person[]; onClose: () => void; onToggle: (p: Person) => void }) {
  return (
    <Modal open onClose={onClose} title={item.name} description={`${item.year ?? ""} ${item.type === "Series" ? "Show" : "Movie"}`.trim()} wide>
      <div className="flex gap-5">
        <Poster itemId={item.id} hasImage={item.hasImage} name={item.name} type={item.type} className="hidden aspect-[2/3] w-36 shrink-0 rounded-xl sm:block" />
        <div className="min-w-0 flex-1 space-y-5">
          <div>
            <h3 className="mb-2 text-sm font-medium">Who it's for</h3>
            <div className="space-y-2">
              {people.map((p) => {
                const assignment = item.people.find((x) => x.id === p.id);
                const suggested = item.suggested.includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => onToggle(p)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                      assignment ? "border-transparent" : "hover:bg-muted",
                    )}
                    style={assignment ? { backgroundColor: `${p.color}18`, borderColor: `${p.color}55` } : undefined}
                  >
                    <Avatar person={p} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {assignment ? SOURCE_LABEL[assignment.source] ?? assignment.source : suggested ? "Suggested: they've watched it" : `Not tagged “${p.tag}”`}
                      </div>
                    </div>
                    <span
                      className={cn("flex h-6 w-6 items-center justify-center rounded-full border", assignment ? "border-transparent text-white" : "text-muted-foreground")}
                      style={assignment ? { backgroundColor: p.color } : undefined}
                    >
                      {assignment ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {item.requestedBy.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Requested in Seerr by <span className="font-medium text-foreground">{item.requestedBy.join(", ")}</span>
            </p>
          )}
          {item.otherTags.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-sm font-medium">Other tags</h3>
              <div className="flex flex-wrap gap-1.5">
                {item.otherTags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function BulkBar({ ids, people, onDone }: { ids: string[]; people: Person[]; onDone: () => void }) {
  const tagMut = useTagMutation();
  const run = (add: number[], remove: number[]) =>
    tagMut.mutate(
      { itemIds: ids, add, remove },
      {
        onSuccess: (res) => {
          toast.success(`Updated ${res.ok} title${res.ok === 1 ? "" : "s"}`);
          onDone();
        },
      },
    );
  return (
    <div className="fixed inset-x-3 bottom-20 z-40 mx-auto max-w-3xl animate-pop-in rounded-2xl border bg-card p-3 shadow-lg lg:bottom-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center justify-between gap-3 sm:justify-start">
          <span className="text-sm font-semibold">{ids.length} selected</span>
          <button onClick={onDone} className="text-[13px] text-muted-foreground hover:text-foreground">
            Clear
          </button>
        </div>
        <div className="flex flex-1 flex-wrap gap-1.5 sm:justify-end">
          {people.map((p) => (
            <span key={p.id} className="inline-flex overflow-hidden rounded-lg border">
              <button
                onClick={() => run([p.id], [])}
                disabled={tagMut.isPending}
                className="flex items-center gap-1.5 py-1 pl-1.5 pr-2 text-[13px] font-medium hover:bg-muted"
                title={`Add ${p.name} to ${ids.length}`}
              >
                <Avatar person={p} size="xs" /> <Plus className="h-3 w-3" />
                <span className="hidden sm:inline">{p.name}</span>
              </button>
              <button onClick={() => run([], [p.id])} disabled={tagMut.isPending} className="border-l px-1.5 text-muted-foreground hover:bg-muted" title={`Remove ${p.name}`}>
                <Minus className="h-3 w-3" />
              </button>
            </span>
          ))}
          <Button size="sm" onClick={() => run(people.map((p) => p.id), [])} loading={tagMut.isPending}>
            Everyone
          </Button>
        </div>
      </div>
    </div>
  );
}
