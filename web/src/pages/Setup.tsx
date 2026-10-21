import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { api, get, type SettingsData } from "@/lib/api";
import { Logo } from "@/components/Layout";
import { ConnectionForm } from "@/components/ConnectionForm";
import { PeopleEditor } from "@/components/PeopleEditor";
import { usePeople } from "@/components/people";
import { WebhookHelp } from "@/pages/Settings";
import { Button, Card, PageSpinner, cn } from "@/components/ui";

const STEPS = ["Jellyfin", "Seerr", "People", "Finish"];

export default function SetupPage() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => get<SettingsData>("/settings") });
  const people = usePeople();
  const [step, setStep] = useState(0);
  const [finishing, setFinishing] = useState(false);

  if (!settings.data) return <PageSpinner />;
  const s = settings.data;

  const finish = async () => {
    setFinishing(true);
    await api("PUT", "/settings", { setupComplete: true });
    await api("POST", "/sync").catch(() => {});
    await qc.invalidateQueries();
  };

  return (
    <div className="min-h-screen px-4 py-8 sm:py-14">
      <div className="mx-auto max-w-2xl animate-fade-in">
        <div className="mb-8 flex items-center gap-3">
          <Logo className="h-10 w-10 rounded-xl" />
          <div>
            <h1 className="text-xl font-semibold">Set up Tagarr</h1>
            <p className="text-sm text-muted-foreground">Four quick steps. Everything can be changed later in Settings.</p>
          </div>
        </div>

        <ol className="mb-6 grid grid-cols-4 gap-2">
          {STEPS.map((label, i) => (
            <li key={label}>
              <button
                onClick={() => i < step && setStep(i)}
                disabled={i > step}
                className={cn("w-full text-left", i < step && "cursor-pointer")}
              >
                <div className={cn("mb-2 h-1.5 rounded-full", i <= step ? "bg-primary" : "bg-muted")} />
                <span className={cn("flex items-center gap-1 text-xs font-medium sm:text-sm", i === step ? "text-foreground" : "text-muted-foreground")}>
                  {i < step && <Check className="h-3.5 w-3.5 text-primary" />}
                  {label}
                </span>
              </button>
            </li>
          ))}
        </ol>

        <Card className="p-5 sm:p-7">
          {step === 0 && (
            <>
              <StepTitle title="Connect Jellyfin" text="Tagarr reads your movies and shows and writes people's tags onto them." />
              <ConnectionForm service="jellyfin" url={s.jellyfinUrl} keySet={s.jellyfinApiKeySet} saveLabel="Save and continue" onSaved={() => setStep(1)} />
            </>
          )}
          {step === 1 && (
            <>
              <StepTitle
                title="Connect Seerr"
                text="So whatever someone requests is tagged with their name as soon as it lands in Jellyfin. Optional: you can tag by hand without it."
              />
              <ConnectionForm
                service="seerr"
                url={s.seerrUrl}
                keySet={s.seerrApiKeySet}
                saveLabel="Save and continue"
                onSaved={() => setStep(2)}
                extra={
                  <Button type="button" variant="ghost" onClick={() => setStep(2)}>
                    Skip
                  </Button>
                }
              />
            </>
          )}
          {step === 2 && (
            <>
              <StepTitle
                title="Who shares the library?"
                text="Each person gets a tag. Link their Seerr account so their requests are tagged automatically, and their Jellyfin account for suggestions and access rules."
              />
              <PeopleEditor />
              <div className="mt-6 flex justify-between border-t pt-5">
                <Button variant="ghost" onClick={() => setStep(1)}>
                  <ArrowLeft className="h-4 w-4" /> Back
                </Button>
                <Button onClick={() => setStep(3)} disabled={!people.data?.length}>
                  Continue <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <StepTitle title="You're set" text="Tagarr syncs every 15 minutes. Two optional extras make it instant and private:" />
              <div className="space-y-5 text-sm">
                <div>
                  <h3 className="mb-1.5 font-medium">1. Instant tagging (recommended)</h3>
                  <WebhookHelp path={s.webhookPath} />
                </div>
                <div>
                  <h3 className="mb-1.5 font-medium">2. Hide other people's items</h3>
                  <p className="text-muted-foreground">
                    Once everything is tagged, the <strong>Access</strong> page sets each Jellyfin user to only see items with their tag. Anything you both request
                    carries both tags, so it shows for both of you.
                  </p>
                </div>
              </div>
              <div className="mt-7 flex justify-between border-t pt-5">
                <Button variant="ghost" onClick={() => setStep(2)}>
                  <ArrowLeft className="h-4 w-4" /> Back
                </Button>
                <Button onClick={finish} loading={finishing}>
                  Finish and sync <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function StepTitle({ title, text }: { title: string; text: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{text}</p>
    </div>
  );
}
