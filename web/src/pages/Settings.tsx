import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Info, KeyRound, LayoutDashboard, Library as LibraryIcon, Plug, RefreshCw, Trash2, Users, Wand2, Webhook } from "lucide-react";
import { toast } from "sonner";
import { api, get, type About, type Library, type SettingsData } from "@/lib/api";
import { PageHeader } from "@/components/Layout";
import { ConnectionForm } from "@/components/ConnectionForm";
import { PeopleEditor } from "@/components/PeopleEditor";
import { showUpdatePrompt, useAbout } from "@/components/UpdatePrompt";
import { PersonChip, usePeople } from "@/components/people";
import { Button, Card, CardBody, CardHeader, Field, Input, Modal, PageSpinner, Switch, cn, timeAgo } from "@/components/ui";

export default function SettingsPage() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => get<SettingsData>("/settings") });
  const location = useLocation();
  useEffect(() => {
    if (!location.hash || !settings.data) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [location.hash, settings.data]);

  if (!settings.data) return <PageSpinner />;
  const s = settings.data;

  return (
    <div className="animate-fade-in">
      <PageHeader title="Settings" />
      <div className="space-y-6">
        <Card id="connections" className="scroll-mt-20">
          <CardHeader icon={<Plug className="h-5 w-5" />} title="Connections" description="Where Tagarr finds Jellyfin and Seerr. Keys are stored on this server and never sent to the browser." />
          <CardBody className="grid gap-8 lg:grid-cols-2">
            <div>
              <h3 className="mb-3 text-sm font-semibold">Jellyfin</h3>
              <ConnectionForm service="jellyfin" url={s.jellyfinUrl} keySet={s.jellyfinApiKeySet} />
            </div>
            <div>
              <h3 className="mb-3 text-sm font-semibold">Seerr</h3>
              <ConnectionForm service="seerr" url={s.seerrUrl} keySet={s.seerrApiKeySet} />
            </div>
          </CardBody>
        </Card>

        <Card id="people" className="scroll-mt-20">
          <CardHeader icon={<Users className="h-5 w-5" />} title="People" description="Each person is a tag. Their Seerr requests get it automatically." />
          <CardBody>
            <PeopleEditor />
          </CardBody>
        </Card>

        <Card id="webhook" className="scroll-mt-20">
          <CardHeader icon={<Webhook className="h-5 w-5" />} title="Instant tagging" description="Without this, new requests are tagged at the next scheduled sync." />
          <CardBody>
            <WebhookHelp path={s.webhookPath} rotatable />
          </CardBody>
        </Card>

        <AutomationCard s={s} />
        <LibrariesCard s={s} />
        <WidgetCard />
        <AccountCard username={s.adminUsername} />
        <AboutCard />
      </div>
    </div>
  );
}

function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api("PUT", "/settings", patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      toast.success("Saved");
    },
    onError: (err) => toast.error(err.message),
  });
}

export function WebhookHelp({ path, rotatable }: { path: string; rotatable?: boolean }) {
  const url = `${window.location.origin}${path}`;
  const save = useSaveSettings();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy. Select the address and copy it by hand.");
    }
  };
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        In Seerr, open <strong className="text-foreground">Settings → Notifications → Webhook</strong>, turn it on, paste this as the <strong className="text-foreground">Webhook URL</strong>,
        and tick <strong className="text-foreground">Request Approved</strong>, <strong className="text-foreground">Request Automatically Approved</strong> and{" "}
        <strong className="text-foreground">Media Available</strong>. Leave the JSON payload as it is.
      </p>
      <div className="flex gap-2">
        <Input readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button variant="outline" onClick={copy} className="shrink-0">
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="flex gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-px h-3.5 w-3.5 shrink-0" />
        If Seerr reaches Tagarr by another address (e.g. http://tagarr:8686 on the same Docker network), use that host with the same path. The Jellyfin Webhook
        plugin can call it too, on “Item Added”.
      </p>
      {rotatable && (
        <Button variant="ghost" size="sm" onClick={() => save.mutate({ rotateWebhook: true })} loading={save.isPending}>
          <RefreshCw className="h-3.5 w-3.5" /> New secret address
        </Button>
      )}
    </div>
  );
}

function AutomationCard({ s }: { s: SettingsData }) {
  const save = useSaveSettings();
  const people = usePeople();
  const [interval, setIntervalValue] = useState(String(s.syncIntervalMinutes));
  const [grace, setGrace] = useState(String(s.unrequestedGraceHours));
  const [chosen, setChosen] = useState<number[]>(s.unrequestedPeople);

  return (
    <Card id="automation" className="scroll-mt-20">
      <CardHeader icon={<Wand2 className="h-5 w-5" />} title="Automation" />
      <CardBody className="space-y-6">
        <Row title="Sync every" text="Reads Jellyfin and Seerr, tags new arrivals and puts back tags lost to metadata refreshes.">
          <div className="flex items-center gap-2">
            <Input value={interval} onChange={(e) => setIntervalValue(e.target.value)} className="w-20" inputMode="numeric" aria-label="Minutes" />
            <span className="text-sm text-muted-foreground">min</span>
            {interval !== String(s.syncIntervalMinutes) && (
              <Button size="sm" onClick={() => save.mutate({ syncIntervalMinutes: Number(interval) })}>
                Save
              </Button>
            )}
          </div>
        </Row>

        <div className="border-t" />

        <div>
          <Row
            title="Items nobody requested"
            text="Things added to Jellyfin outside Seerr (or before you connected it) would otherwise stay untagged and hidden from everyone with an access rule."
          >
            <Switch
              checked={s.unrequestedAction === "tag"}
              onChange={(v) => save.mutate({ unrequestedAction: v ? "tag" : "none", unrequestedPeople: chosen })}
              label="Tag unrequested items"
            />
          </Row>
          {s.unrequestedAction === "tag" && (
            <div className="mt-4 space-y-4 rounded-xl bg-muted/50 p-4">
              <Field label="Give them to" hint="Applied once per item: if you later take everyone off an item, it stays that way.">
                <div className="flex flex-wrap gap-2">
                  {people.data?.map((p) => {
                    const on = chosen.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        onClick={() => {
                          const next = on ? chosen.filter((id) => id !== p.id) : [...chosen, p.id];
                          setChosen(next);
                          save.mutate({ unrequestedPeople: next });
                        }}
                        className={cn(!on && "opacity-50 hover:opacity-80")}
                      >
                        <PersonChip person={p} muted={!on} />
                      </button>
                    );
                  })}
                </div>
              </Field>
              <Field label="After" hint="Gives Seerr's request time to be matched first.">
                <div className="flex items-center gap-2">
                  <Input value={grace} onChange={(e) => setGrace(e.target.value)} className="w-20" inputMode="numeric" />
                  <span className="text-sm text-muted-foreground">hours in Jellyfin</span>
                  {grace !== String(s.unrequestedGraceHours) && (
                    <Button size="sm" onClick={() => save.mutate({ unrequestedGraceHours: Number(grace) })}>
                      Save
                    </Button>
                  )}
                </div>
              </Field>
            </div>
          )}
        </div>

        <div className="border-t" />

        <Row title="Suggestions from watch history" text="Lists titles a linked Jellyfin user has watched but isn't tagged on, so you can catch strays. Nothing is tagged without you.">
          <Switch checked={s.watchSuggestions} onChange={(v) => save.mutate({ watchSuggestions: v })} label="Watch-history suggestions" />
        </Row>

        <div className="border-t" />

        <Row
          title="Tag seasons and episodes too"
          text="Jellyfin 10.9 and newer apply a show's tags to its episodes by themselves, so this is usually off. Turn it on if episodes of a hidden show still appear in Continue Watching or Latest."
        >
          <Switch checked={s.tagChildren} onChange={(v) => save.mutate({ tagChildren: v })} label="Tag seasons and episodes" />
        </Row>
      </CardBody>
    </Card>
  );
}

function LibrariesCard({ s }: { s: SettingsData }) {
  const save = useSaveSettings();
  const libraries = useQuery({ queryKey: ["libraries"], queryFn: () => get<Library[]>("/libraries") });
  const [chosen, setChosen] = useState<string[]>(s.libraries);
  const all = chosen.length === 0;
  const dirty = JSON.stringify([...chosen].sort()) !== JSON.stringify([...s.libraries].sort());
  return (
    <Card id="libraries" className="scroll-mt-20">
      <CardHeader icon={<LibraryIcon className="h-5 w-5" />} title="Libraries" description="Which Jellyfin libraries Tagarr manages." />
      <CardBody className="space-y-3">
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={all} onChange={() => setChosen(all ? (libraries.data ?? []).map((l) => l.id) : [])} className="h-4 w-4 accent-[hsl(var(--primary))]" />
          All movie and show libraries
        </label>
        {!all &&
          libraries.data?.map((l) => (
            <label key={l.id} className="ml-7 flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={chosen.includes(l.id)}
                onChange={(e) => setChosen(e.target.checked ? [...chosen, l.id] : chosen.filter((id) => id !== l.id))}
                className="h-4 w-4 accent-[hsl(var(--primary))]"
              />
              {l.name} <span className="text-xs text-muted-foreground">{l.type}</span>
            </label>
          ))}
        {dirty && (
          <Button size="sm" onClick={() => save.mutate({ libraries: chosen })} disabled={!all && chosen.length === 0}>
            Save
          </Button>
        )}
      </CardBody>
    </Card>
  );
}

interface WidgetKey {
  id: number;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

function homepageYaml(key: string) {
  const origin = window.location.origin;
  return `- Tagarr:
    icon: ${origin}/icon-192.png
    href: ${origin}/
    description: Who sees what in Jellyfin
    widget:
      type: customapi
      url: ${origin}/api/widget
      refreshInterval: 300000
      headers:
        X-Api-Key: ${key}
      mappings:
        - field: untagged
          label: Untagged
          format: number
        - field: shared
          label: Shared
          format: number
        - field: waiting
          label: Waiting
          format: number
        - field: suggestions
          label: Suggestions
          format: number`;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Couldn't copy. Select it and copy by hand.");
        }
      }}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

function WidgetCard() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["widget-keys"], queryFn: () => get<WidgetKey[]>("/widget-keys") });
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<WidgetKey | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ id: number; key: string }>("POST", "/widget-keys", { label: label || "Homepage" }),
    onSuccess: (res) => {
      setCreated(res.key);
      setLabel("");
      qc.invalidateQueries({ queryKey: ["widget-keys"] });
    },
    onError: (err) => toast.error(err.message),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api("DELETE", `/widget-keys/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["widget-keys"] });
      toast.success("Key revoked");
      setRevoking(null);
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Card id="widget" className="scroll-mt-20">
      <CardHeader
        icon={<LayoutDashboard className="h-5 w-5" />}
        title="Homepage widget"
        description={
          <>
            Show untagged, shared, waiting and suggestion counts on a{" "}
            <a href="https://gethomepage.dev/widgets/services/customapi/" target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
              Homepage
            </a>{" "}
            dashboard with its Custom API widget. The key only reads these numbers.
          </>
        }
      />
      <CardBody className="space-y-4">
        {created ? (
          <div className="space-y-3 rounded-xl border border-primary/30 bg-primary-soft/40 p-4">
            <p className="text-sm font-medium">Copy this key now: it won't be shown again.</p>
            <div className="flex gap-2">
              <Input readOnly value={created} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
              <CopyButton text={created} />
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm font-medium">Add this to Homepage's services.yaml</span>
                <CopyButton text={homepageYaml(created)} label="Copy YAML" />
              </div>
              <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-[11px] leading-relaxed">{homepageYaml(created)}</pre>
              <p className="mt-1.5 text-xs text-muted-foreground">
                If Homepage reaches this app by another address (e.g. on a shared Docker network), change <code>url</code> to that. More fields: <code>total</code>,{" "}
                <code>tagged_pct</code> (format: percent), <code>last_sync</code> (format: relativeDate), and per person{" "}
                <code>{"field: { people: <tag> }"}</code>.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, e.g. Homepage" className="sm:max-w-xs" aria-label="Key label" />
            <Button type="submit" variant="outline" loading={create.isPending}>
              Create key
            </Button>
          </form>
        )}

        {!!keys.data?.length && (
          <ul className="divide-y rounded-xl border">
            {keys.data.map((k) => (
              <li key={k.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="flex-1 font-medium">{k.label}</span>
                <span className="text-xs text-muted-foreground">
                  {k.last_used_at ? `used ${timeAgo(k.last_used_at)}` : "never used"} · made {timeAgo(k.created_at)}
                </span>
                <Button variant="ghost" size="icon" onClick={() => setRevoking(k)} aria-label={`Revoke ${k.label}`}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      {revoking && (
        <Modal
          open
          onClose={() => setRevoking(null)}
          title={`Revoke “${revoking.label}”?`}
          description="Anything using this key stops getting numbers straight away."
          footer={
            <>
              <Button variant="outline" onClick={() => setRevoking(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => revoke.mutate(revoking.id)} loading={revoke.isPending}>
                Revoke
              </Button>
            </>
          }
        >
          <span />
        </Modal>
      )}
    </Card>
  );
}

function AccountCard({ username }: { username: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () => api("POST", "/account/password", { current, next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      toast.success("Password changed. Other devices were signed out.");
    },
    onError: (err) => toast.error(err.message),
  });
  return (
    <Card id="account" className="scroll-mt-20">
      <CardHeader icon={<KeyRound className="h-5 w-5" />} title="Account" description={`Signed in as ${username}.`} />
      <CardBody>
        <form
          className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate();
          }}
        >
          <Field label="Current password" htmlFor="cur">
            <Input id="cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </Field>
          <Field label="New password" htmlFor="new">
            <Input id="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} />
          </Field>
          <Button type="submit" variant="outline" loading={change.isPending}>
            Change password
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function AboutCard() {
  const about = useAbout();
  const qc = useQueryClient();
  const check = useMutation({
    mutationFn: () => api<About>("POST", "/about/check"),
    onSuccess: (data) => {
      qc.setQueryData(["about"], data);
      if (data.updateAvailable) showUpdatePrompt();
      else toast.success(`You're up to date (${data.version})`);
    },
    onError: (err) => toast.error(err.message),
  });
  if (!about.data) return null;
  const a = about.data;
  return (
    <Card id="about" className="scroll-mt-20">
      <CardBody className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="font-semibold">Tagarr</span> <span className="text-muted-foreground">{a.version}</span>
          <span className="ml-2 text-muted-foreground">
            {!a.update.enabled
              ? "· update check off"
              : a.updateAvailable
                ? `· ${a.update.latest} is available`
                : a.update.latest
                  ? "· up to date"
                  : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {a.updateAvailable ? (
            <button onClick={showUpdatePrompt} className="font-medium text-primary hover:underline">
              What's new
            </button>
          ) : (
            a.update.enabled && (
              <button onClick={() => check.mutate()} disabled={check.isPending} className="font-medium text-primary hover:underline disabled:opacity-60">
                {check.isPending ? "Checking…" : "Check for updates"}
              </button>
            )
          )}
          <a href={`https://github.com/${a.repo}`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
            GitHub
          </a>
          <a href={`https://github.com/${a.repo}/releases`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
            Releases
          </a>
        </div>
      </CardBody>
    </Card>
  );
}

function Row({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
      <div className="max-w-xl">
        <div className="text-sm font-medium">{title}</div>
        <p className="mt-0.5 text-sm text-muted-foreground">{text}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
