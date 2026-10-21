import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button, Field, Input } from "./ui";

type Service = "jellyfin" | "seerr";

const COPY: Record<Service, { name: string; placeholder: string; keyHint: React.ReactNode }> = {
  jellyfin: {
    name: "Jellyfin",
    placeholder: "http://jellyfin:8096",
    keyHint: (
      <>
        In Jellyfin: <strong>Dashboard → API Keys → +</strong>. Name it “Autotagarr”.
      </>
    ),
  },
  seerr: {
    name: "Seerr",
    placeholder: "http://seerr:5055",
    keyHint: (
      <>
        In Seerr: <strong>Settings → General → API Key</strong>. Jellyseerr and Overseerr work too.
      </>
    ),
  },
};

interface TestResult {
  ok: boolean;
  text: string;
}

export function ConnectionForm({
  service,
  url: initialUrl,
  keySet,
  onSaved,
  saveLabel = "Save",
  extra,
}: {
  service: Service;
  url: string;
  keySet: boolean;
  onSaved?: () => void;
  saveLabel?: string;
  extra?: React.ReactNode;
}) {
  const qc = useQueryClient();
  const copy = COPY[service];
  const [url, setUrl] = useState(initialUrl);
  const [key, setKey] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const test = async (): Promise<boolean> => {
    setTesting(true);
    setResult(null);
    try {
      const res = await api<{ serverName?: string; version: string; users: number; libraries?: unknown[] }>("POST", `/test/${service}`, {
        url,
        apiKey: key || undefined,
      });
      setResult({
        ok: true,
        text:
          service === "jellyfin"
            ? `Connected to ${res.serverName} (Jellyfin ${res.version}), ${res.users} users`
            : `Connected to Seerr ${res.version}, ${res.users} users`,
      });
      return true;
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "Couldn't connect" });
      return false;
    } finally {
      setTesting(false);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(await test())) return;
    setSaving(true);
    try {
      await api("PUT", "/settings", service === "jellyfin" ? { jellyfinUrl: url, jellyfinApiKey: key || undefined } : { seerrUrl: url, seerrApiKey: key || undefined });
      setKey("");
      await qc.invalidateQueries();
      toast.success(`${copy.name} saved`);
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-4">
      <Field label={`${copy.name} address`} htmlFor={`${service}-url`} hint="The address Autotagarr's container can reach it at, e.g. its compose service name, or a LAN IP and port.">
        <Input id={`${service}-url`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={copy.placeholder} required inputMode="url" autoComplete="off" />
      </Field>
      <Field label="API key" htmlFor={`${service}-key`} hint={copy.keyHint}>
        <Input
          id={`${service}-key`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={keySet ? "Saved — leave blank to keep it" : "Paste the API key"}
          required={!keySet}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-[13px]"
        />
      </Field>
      {result && (
        <div className={`flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm ${result.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
          {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          {result.text}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={saving}>
          {saveLabel}
        </Button>
        <Button type="button" variant="outline" onClick={test} loading={testing} disabled={!url || (!key && !keySet)}>
          Test
        </Button>
        {extra}
      </div>
    </form>
  );
}
