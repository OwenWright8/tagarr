import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  CalendarRange,
  Inbox,
  LayoutDashboard,
  Library as LibraryIcon,
  LogOut,
  Monitor,
  Moon,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, get, type About, type Overview, type SyncStatus } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { cn, timeAgo } from "./ui";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/library", label: "Library", icon: LibraryIcon },
  { to: "/seasonal", label: "Seasonal", icon: CalendarRange },
  { to: "/requests", label: "Requests", icon: Inbox },
  { to: "/suggestions", label: "Suggestions", icon: Sparkles, badge: "suggestions" as const },
  { to: "/access", label: "Access", icon: ShieldCheck },
  { to: "/activity", label: "Activity", icon: ActivityIcon },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];
const MOBILE_NAV = ["/", "/library", "/requests", "/suggestions", "/settings"];

export function Logo({ className }: { className?: string }) {
  return <img src="/icon.svg" alt="" className={cn("h-8 w-8 rounded-[9px]", className)} />;
}

export function useOverview() {
  return useQuery({ queryKey: ["overview"], queryFn: () => get<Overview>("/overview"), refetchInterval: 30_000 });
}

export function useSync() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["sync"],
    queryFn: () => get<SyncStatus>("/sync"),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : 30_000),
  });
  const wasRunning = useWasRunning(status.data?.running);
  useEffect(() => {
    if (wasRunning && !status.data?.running) qc.invalidateQueries();
  }, [wasRunning, status.data?.running, qc]);
  const run = useMutation({
    mutationFn: () => api<SyncStatus>("POST", "/sync"),
    onSuccess: (data) => {
      qc.setQueryData(["sync"], data);
      if (!data.running) qc.invalidateQueries();
    },
  });
  return { status: status.data, run };
}

function useWasRunning(running: boolean | undefined) {
  const [prev, setPrev] = useState(false);
  const [was, setWas] = useState(false);
  if (!!running !== prev) {
    setWas(prev);
    setPrev(!!running);
  }
  return was;
}

export function SyncButton({ compact }: { compact?: boolean }) {
  const { status, run } = useSync();
  const busy = status?.running || run.isPending;
  return (
    <button
      onClick={() => run.mutate()}
      disabled={busy}
      className={cn(
        "group flex items-center gap-2.5 rounded-lg text-left text-[13px] transition-colors hover:bg-muted disabled:opacity-80",
        compact ? "p-2" : "w-full px-3 py-2",
      )}
      title="Sync with Jellyfin and Seerr now"
    >
      <RefreshCw className={cn("h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground", busy && "animate-spin text-primary")} />
      {!compact && (
        <span className="min-w-0">
          <span className="block font-medium">{busy ? "Syncing…" : "Sync now"}</span>
          <span className={cn("block truncate text-xs", status?.ok === false ? "text-destructive" : "text-muted-foreground")}>
            {status?.ok === false ? "Last sync had problems" : `Last sync ${timeAgo(status?.finishedAt)}`}
          </span>
        </span>
      )}
    </button>
  );
}

function ThemeButton() {
  const [theme, setTheme] = useTheme();
  const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  return (
    <button
      onClick={() => setTheme(next)}
      className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
      title={`Theme: ${theme} (click for ${next})`}
      aria-label={`Theme: ${theme}`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function UpdateBanner() {
  const about = useQuery({ queryKey: ["about"], queryFn: () => get<About>("/about"), staleTime: 3_600_000 });
  const latest = about.data?.update.latest;
  const key = `tagarr-dismissed-${latest}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return !!localStorage.getItem(key);
    } catch {
      return false;
    }
  });
  if (!about.data?.updateAvailable || dismissed || !latest) return null;
  return (
    <div className="flex items-center justify-center gap-3 border-b bg-primary-soft px-4 py-2 text-[13px] text-primary">
      <span>
        <strong className="font-semibold">Tagarr {latest}</strong> is available —{" "}
        <a href={about.data.update.url ?? "#"} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
          What's new
        </a>
      </span>
      <button
        onClick={() => {
          try {
            localStorage.setItem(key, "1");
          } catch {
            // Not remembered, but hidden for now.
          }
          setDismissed(true);
        }}
        className="rounded p-0.5 hover:bg-primary/10"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function Layout({ onSignOut }: { onSignOut: () => void }) {
  const overview = useOverview();
  const location = useLocation();
  const counts = { suggestions: overview.data?.totals.suggestions ?? 0 };
  useEffect(() => window.scrollTo(0, 0), [location.pathname]);

  return (
    <div className="min-h-screen">
      <UpdateBanner />
      <div className="flex">
        {/* Sidebar (desktop) */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card/60 px-3 py-4 lg:flex">
          <div className="mb-6 flex items-center gap-2.5 px-2">
            <Logo />
            <span className="text-[17px] font-semibold tracking-tight">Tagarr</span>
          </div>
          <nav className="flex flex-col gap-0.5">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    isActive ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )
                }
              >
                <item.icon className="h-[18px] w-[18px]" />
                <span className="flex-1">{item.label}</span>
                {item.badge && counts[item.badge] > 0 && (
                  <span className="rounded-full bg-primary px-1.5 py-px text-[11px] font-semibold text-primary-foreground">{counts[item.badge]}</span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto space-y-1 border-t pt-3">
            <SyncButton />
            <div className="flex items-center justify-between px-1">
              <ThemeButton />
              <button
                onClick={onSignOut}
                className="flex items-center gap-1.5 rounded-lg p-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          {/* Top bar (mobile) */}
          <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/85 px-4 py-2.5 backdrop-blur lg:hidden">
            <div className="flex items-center gap-2">
              <Logo className="h-7 w-7" />
              <span className="font-semibold tracking-tight">Tagarr</span>
            </div>
            <div className="flex items-center">
              <SyncButton compact />
              <ThemeButton />
            </div>
          </header>

          <main className="mx-auto max-w-6xl px-4 pb-28 pt-5 sm:px-6 lg:px-10 lg:pb-16 lg:pt-9">
            <Outlet />
          </main>

          {/* Bottom tabs (mobile) */}
          <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
            {NAV.filter((n) => MOBILE_NAV.includes(n.to)).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn("relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium", isActive ? "text-primary" : "text-muted-foreground")
                }
              >
                <item.icon className="h-5 w-5" />
                {item.label}
                {item.badge && counts[item.badge] > 0 && <span className="absolute right-[calc(50%-18px)] top-1.5 h-2 w-2 rounded-full bg-primary" />}
              </NavLink>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground sm:text-[15px]">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
