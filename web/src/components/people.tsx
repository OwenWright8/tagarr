// How people and items look everywhere: colored avatars, tag chips, posters.
import { useQuery } from "@tanstack/react-query";
import { Film, Tv } from "lucide-react";
import { useState } from "react";
import { get, type Person } from "@/lib/api";
import { cn } from "./ui";

export function usePeople() {
  return useQuery({ queryKey: ["people"], queryFn: () => get<Person[]>("/people") });
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function Avatar({ person, size = "md", className, ring }: { person: Pick<Person, "name" | "color">; size?: "xs" | "sm" | "md" | "lg"; className?: string; ring?: boolean }) {
  const sizes = { xs: "h-5 w-5 text-[9px]", sm: "h-6 w-6 text-[10px]", md: "h-8 w-8 text-xs", lg: "h-11 w-11 text-sm" };
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white",
        ring && "ring-2 ring-card",
        sizes[size],
        className,
      )}
      style={{ backgroundColor: person.color }}
      title={person.name}
    >
      {initials(person.name)}
    </span>
  );
}

export function PersonChip({ person, onRemove, muted }: { person: Pick<Person, "name" | "color">; onRemove?: () => void; muted?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2.5 text-xs font-medium",
        muted ? "border border-dashed" : "",
      )}
      style={{ backgroundColor: muted ? "transparent" : `${person.color}1f`, color: person.color, borderColor: muted ? person.color : undefined }}
    >
      <Avatar person={person} size="xs" />
      {person.name}
      {onRemove && (
        <button onClick={onRemove} className="-mr-1 ml-0.5 rounded-full px-1 opacity-70 hover:opacity-100" aria-label={`Remove ${person.name}`}>
          ×
        </button>
      )}
    </span>
  );
}

export function AvatarStack({ people, max = 4 }: { people: Pick<Person, "name" | "color">[]; max?: number }) {
  const shown = people.slice(0, max);
  return (
    <span className="flex -space-x-1.5">
      {shown.map((p) => (
        <Avatar key={p.name} person={p} size="sm" ring />
      ))}
      {people.length > max && (
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold ring-2 ring-card">+{people.length - max}</span>
      )}
    </span>
  );
}

export function Poster({ itemId, hasImage, name, type, className }: { itemId: string; hasImage: boolean; name: string; type: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const Icon = type === "Series" || type === "tv" ? Tv : Film;
  return (
    <div className={cn("relative overflow-hidden bg-muted", className)}>
      {hasImage && !failed ? (
        <img
          src={`/api/items/${itemId}/image`}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-muted to-secondary p-3 text-center text-muted-foreground">
          <Icon className="h-6 w-6 opacity-60" />
          <span className="line-clamp-3 text-xs font-medium">{name}</span>
        </div>
      )}
    </div>
  );
}

export const COLORS = ["#7c5cbf", "#d9677e", "#3f8f84", "#d08a3a", "#4f7cc0", "#8a9a3b", "#b4589f", "#5c6b7a"];
