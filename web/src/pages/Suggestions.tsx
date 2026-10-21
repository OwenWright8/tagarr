import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { api, get, type Person, type Suggestion } from "@/lib/api";
import { PageHeader } from "@/components/Layout";
import { Avatar, Poster, usePeople } from "@/components/people";
import { Button, Card, EmptyState, PageSpinner } from "@/components/ui";

export default function SuggestionsPage() {
  const qc = useQueryClient();
  const people = usePeople();
  const suggestions = useQuery({ queryKey: ["suggestions"], queryFn: () => get<Suggestion[]>("/suggestions") });
  const done = () => {
    qc.invalidateQueries({ queryKey: ["suggestions"] });
    qc.invalidateQueries({ queryKey: ["overview"] });
    qc.invalidateQueries({ queryKey: ["items"] });
  };
  const accept = useMutation({
    mutationFn: (pairs: { itemId: string; personId: number }[]) => api<{ ok: number }>("POST", "/suggestions/accept", { pairs }),
    onSuccess: (res) => {
      toast.success(`Tagged ${res.ok} title${res.ok === 1 ? "" : "s"}`);
      done();
    },
    onError: (err) => toast.error(err.message),
  });
  const dismiss = useMutation({
    mutationFn: (pairs: { itemId: string; personId: number }[]) => api("POST", "/suggestions/dismiss", { pairs }),
    onSuccess: done,
  });

  const groups = useMemo(() => {
    const map = new Map<number, Suggestion[]>();
    for (const s of suggestions.data ?? []) map.set(s.personId, [...(map.get(s.personId) ?? []), s]);
    return [...map.entries()]
      .map(([id, list]) => ({ person: people.data?.find((p) => p.id === id), list }))
      .filter((g): g is { person: Person; list: Suggestion[] } => !!g.person);
  }, [suggestions.data, people.data]);

  if (!suggestions.data || !people.data) return <PageSpinner />;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Suggestions"
        description="Titles someone has watched in Jellyfin that aren't tagged for them. A quick way to catch anything that slipped through."
      />
      {groups.length === 0 ? (
        <EmptyState icon={<Sparkles className="h-5 w-5" />} title="No suggestions">
          When a linked Jellyfin user watches something that isn't tagged for them, it shows up here. Link Jellyfin users to people in Settings.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {groups.map(({ person, list }) => (
            <Card key={person.id}>
              <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:px-6">
                <div className="flex flex-1 items-center gap-3">
                  <Avatar person={person} size="lg" />
                  <div>
                    <h2 className="font-semibold">{person.name} watched</h2>
                    <p className="text-sm text-muted-foreground">
                      {list.length} title{list.length === 1 ? "" : "s"} without the “{person.tag}” tag
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => dismiss.mutate(list.map((s) => ({ itemId: s.itemId, personId: s.personId })))}>
                    Dismiss all
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => accept.mutate(list.map((s) => ({ itemId: s.itemId, personId: s.personId })))}
                    loading={accept.isPending}
                  >
                    <Check className="h-4 w-4" /> Tag all for {person.name}
                  </Button>
                </div>
              </div>
              <ul className="grid gap-px bg-border sm:grid-cols-2">
                {list.map((s) => (
                  <li key={s.itemId} className="flex items-center gap-3 bg-card px-4 py-3 sm:px-6">
                    <Poster itemId={s.itemId} hasImage={s.hasImage} name="" type={s.type} className="h-14 w-10 shrink-0 rounded-md" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{s.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {s.year ?? "—"} · {s.type === "Series" ? "Show" : "Movie"}
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => dismiss.mutate([{ itemId: s.itemId, personId: s.personId }])} aria-label="Dismiss">
                      <X className="h-4 w-4" />
                    </Button>
                    <Button variant="secondary" size="icon" onClick={() => accept.mutate([{ itemId: s.itemId, personId: s.personId }])} aria-label={`Tag for ${person.name}`}>
                      <Check className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
