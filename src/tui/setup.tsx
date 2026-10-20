import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { type CatalogModel, type Choice, INDEX, hfUrl, licenceLabel, listModels, rank } from "../catalog.js";
import type { JevServer, LocalModel } from "../config.js";
import { type Fit, GIB, type Machine, budgetBytes, detectMachine } from "../estimate.js";
import { findRunningServers } from "../server.js";
import { type SetupIO, installLocal, runtimeReady, useServer } from "../setup.js";
import { bar } from "./charts.js";
import { Dialog, type Hint, SelectDialog } from "./dialog.js";
import { wrapLine } from "./history.js";
import { useTheme } from "./theme.js";

/** What the setup reaches outside the TUI. Tests replace each part, so no test touches the network or a real binary. */
export interface SetupSeam {
  listModels?: () => Promise<CatalogModel[]>;
  machine?: Machine;
  install?: (choice: Choice, io: SetupIO) => Promise<LocalModel>;
  /** Whether Homebrew would have to install or upgrade llama.cpp before a model of this decision type runs. */
  runtimeNeeded?: (type: string) => boolean;
  /** The Jev servers already running on this machine, offered before any download. */
  findServers?: () => Promise<JevServer[]>;
}

/** The same test installRuntime makes, so the confirm screen says Homebrew exactly when the install will ask for it. */
const runtimeNeeded = (type: string): boolean => !runtimeReady(type, process.env);

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** "too big" in the picker: a short word for a row that only refuses. */
const FIT_WORD: Record<Fit, string> = { "runs well": "runs well", tight: "tight", "won't fit": "too big" };

/** The machine line the picker is titled with, "Apple M4 Pro, 24 GB": memory in the size a machine is sold as. */
export const machineLine = (m: Machine): string => `${m.chip}, ${Math.round(m.ramBytes / GIB)} GB`;

/** One picker row's hint: what it downloads, whether it fits, its score and its seconds per question. */
export const choiceHint = (c: Choice): string =>
  [gb(c.quant.bytes), FIT_WORD[c.fit], c.model.score === null ? "-" : c.model.score.toFixed(1), c.seconds === null ? "-" : `${c.seconds.toFixed(1)}s`].join(" · ");

type Step =
  | { at: "choose" }
  | { at: "typesafe" }
  | { at: "loading" }
  | { at: "pick"; machine: Machine; choices: Choice[]; servers: JevServer[] }
  | { at: "confirm"; machine: Machine; choices: Choice[]; servers: JevServer[]; choice: Choice; brew: boolean }
  | { at: "installing"; choice: Choice; step: string; done?: number; total?: number }
  | { at: "checking"; server: JevServer }
  | { at: "error"; message: string };

const KEYS: Record<Step["at"], Hint[]> = {
  choose: [["↑↓", "move"], ["enter", "choose"], ["esc", "close"]],
  typesafe: [["esc", "close"]],
  loading: [["esc", "close"]],
  pick: [["↑↓", "move"], ["enter", "choose"], ["esc", "back"]],
  confirm: [["enter", "install"], ["esc", "back"]],
  // The download and the model load cannot be left halfway from here; ctrl+c still quits, and a later install resumes the download.
  installing: [],
  checking: [],
  error: [["esc", "close"]],
};

/**
 * Setting up Jev from the TUI: hosted TypeSafe (instructions only, the key is never typed here) or a model on
 * this machine, picked from the ranked list and installed by the same installLocal the CLI runs.
 */
export function SetupDialog(props: {
  home: string;
  columns: number;
  rows: number;
  seam?: SetupSeam;
  onKeys: (hints: Hint[]) => void;
  onToast: (text: string, error: boolean) => void;
  /** The name of the model Jev now runs on. */
  onDone: (name: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const seam = props.seam ?? {};
  const [step, setStep] = useState<Step>({ at: "choose" });
  useEffect(() => { props.onKeys(KEYS[step.at]); }, [step.at]);

  const load = (): void => {
    setStep({ at: "loading" });
    // Closing while this runs unmounts the dialog, and the late answer goes nowhere.
    Promise.resolve()
      .then(async () => {
        const machine = seam.machine ?? detectMachine(process.env);
        const servers = await (seam.findServers ?? findRunningServers)();
        // A server already running needs no download, so it is offered even when Hugging Face cannot be reached.
        const models = await (seam.listModels ?? (() => listModels({ hfUrl: hfUrl(process.env) })))().catch((e: unknown) => {
          if (servers.length === 0) throw e;
          return [];
        });
        return { machine, servers, choices: rank(models, machine) };
      })
      .then((found) => setStep({ at: "pick", ...found }), (e: unknown) => setStep({ at: "error", message: message(e) }));
  };

  const install = (choice: Choice): void => {
    setStep({ at: "installing", choice, step: "checking llama.cpp" });
    const io: SetupIO = {
      say: (line) => setStep((s) => (s.at === "installing" ? { at: "installing", choice: s.choice, step: line } : s)),
      progress: (text, done, total) => setStep((s) => (s.at === "installing" ? { at: "installing", choice: s.choice, step: text, ...(done !== undefined && total !== undefined ? { done, total } : {}) } : s)),
      // The confirm dialog already asked, Homebrew included.
      confirm: async () => true,
    };
    (seam.install ?? ((c: Choice, i: SetupIO) => installLocal(c, props.home, i, process.env)))(choice, io)
      .then((local) => props.onDone(local.name), (e: unknown) => setStep({ at: "error", message: message(e) }));
  };

  /** The same check and switch as jevelry install --local-url; it says nothing worth a step of its own. */
  const adopt = (server: JevServer): void => {
    setStep({ at: "checking", server });
    const io: SetupIO = { say: () => undefined, progress: () => undefined, confirm: async () => true };
    useServer(server.url, server.model, props.home, io, process.env)
      .then(() => props.onDone(server.model), (e: unknown) => setStep({ at: "error", message: message(e) }));
  };

  // Every branch names its step: a listener from the step before can still be attached for a moment and sees the new
  // step, and enter as the list appears must not close the dialog.
  useInput((_input, key) => {
    if (step.at === "confirm") {
      if (key.return) install(step.choice);
      else if (key.escape) setStep({ at: "pick", machine: step.machine, choices: step.choices, servers: step.servers });
    } else if (step.at === "typesafe" || step.at === "error") {
      if (key.escape || key.return) props.onClose();
    } else if (step.at === "loading" && key.escape) props.onClose();
  }, { isActive: step.at === "confirm" || step.at === "typesafe" || step.at === "loading" || step.at === "error" });

  const { columns, rows } = props;
  if (step.at === "choose") {
    return (
      <SelectDialog<"typesafe" | "local"> key="choose" title="Set up Jev" columns={columns} rows={rows} onClose={props.onClose}
        items={[{ label: "TypeSafe, hosted", value: "typesafe", hint: "needs an API key" }, { label: "A model on this machine", value: "local", hint: "free, private" }]}
        onSelect={(v) => (v === "typesafe" ? setStep({ at: "typesafe" }) : load())} />
    );
  }
  if (step.at === "pick") {
    return (
      <SelectDialog<Choice | JevServer> key="pick" title={machineLine(step.machine)} width={76} columns={columns} rows={rows}
        items={[
          // A server already running needs no download and puts no second model in memory, so it comes first. The
          // hint leaves out the scheme, so the row fits at 80 columns.
          ...step.servers.map((s) => ({ label: `Use ${s.model}, already running`, value: s, hint: `${s.url.replace(/^https?:\/\//, "")} · no download` })),
          ...step.choices.map((c) => ({ label: `${c.model.name} ${c.quant.quant}`, value: c, hint: choiceHint(c) })),
        ]}
        onClose={() => setStep({ at: "choose" })}
        onSelect={(c) => {
          if ("url" in c) adopt(c);
          // A model too big for the GPU's memory is what crashed a machine once: it is never installed from here.
          else if (c.fit === "won't fit") props.onToast(`needs about ${gb(c.need)}; this machine has about ${gb(budgetBytes(step.machine))} for models`, true);
          else setStep({ ...step, at: "confirm", choice: c, brew: (seam.runtimeNeeded ?? runtimeNeeded)(c.model.decisionType) });
        }} />
    );
  }
  if (step.at === "typesafe") {
    return (
      <Dialog title="TypeSafe, hosted" width={60} columns={columns} rows={rows} height={9}>
        <Text> </Text>
        <Text color={theme.text}>Run npx jevelry install --typesafe in a terminal, or export TYPESAFE_API_KEY. Get a key at https://docs.typesafe.ai.</Text>
      </Dialog>
    );
  }
  if (step.at === "loading") {
    return (
      <Dialog title="A model on this machine" width={60} columns={columns} rows={rows} height={7}>
        <Text> </Text>
        <Text color={theme.muted}>Reading decision models from Hugging Face</Text>
      </Dialog>
    );
  }
  const width = 66;
  const inner = Math.min(width, columns - 4) - 4;
  if (step.at === "checking") {
    return (
      <Dialog title={`Using ${step.server.model}`} width={width} columns={columns} rows={rows} height={7}>
        <Text> </Text>
        <Text color={theme.muted} wrap="truncate">Asking {step.server.url} one setup check</Text>
      </Dialog>
    );
  }
  if (step.at === "error") {
    // As many lines of the message as fit above the footer, so a long brew log never pushes the screen past its rows.
    const lines = step.message.split("\n").flatMap((l) => wrapLine(l, inner)).slice(0, Math.max(1, rows - 12));
    return (
      <Dialog title="Setup stopped" width={width} columns={columns} rows={rows} height={6 + lines.length}>
        <Text> </Text>
        {lines.map((l, i) => <Text key={i} color={theme.error} wrap="truncate">{l}</Text>)}
      </Dialog>
    );
  }
  if (step.at === "installing") {
    const { choice, done, total } = step;
    const text = step.step === "download" ? `Downloading ${choice.quant.file}` : step.step;
    const tail = done !== undefined && total !== undefined && total > 0
      ? ` ${String(Math.floor((done / total) * 100)).padStart(3)}%  ${(done / 1e9).toFixed(1)} of ${gb(total)}` : null;
    return (
      <Dialog title={`Installing ${choice.model.name}`} width={width} columns={columns} rows={rows} height={8}>
        <Text> </Text>
        <Text color={theme.text} wrap="truncate">{text}</Text>
        {tail !== null ? (
          <Text wrap="truncate">
            <Text color={theme.accent}>{bar(done! / total!, inner - tail.length)}</Text>
            <Text color={theme.text}>{tail}</Text>
          </Text>
        ) : null}
      </Dialog>
    );
  }
  const { choice, machine } = step;
  const { model } = choice;
  const details: Array<[string, string]> = [
    ["repo", model.repo],
    ["quant", choice.quant.quant],
    ["download", `about ${gb(choice.quant.bytes)}`],
    ["needs", `${gb(choice.need)} of about ${gb(budgetBytes(machine))} for models`],
    ["fit", choice.fit],
    ["score", model.score === null ? model.note ?? "not on the index" : `${model.score.toFixed(1)}, hosted Jev ${INDEX.hosted.toFixed(1)} (${INDEX.name})`],
    ["speed", choice.seconds === null ? "not estimated for this machine" : `about ${choice.seconds.toFixed(1)} s/question`],
    ["licence", licenceLabel(model.licence)],
  ];
  const detailRows = details.reduce((n, [, value]) => n + wrapLine(value, inner - 10).length, 0);
  return (
    <Dialog title={`Install ${model.name}`} width={width} columns={columns} rows={rows} height={8 + detailRows + (step.brew ? 2 : 0)}>
      <Text> </Text>
      {details.map(([label, value]) => (
        <Box key={label}>
          <Box width={10} flexShrink={0}><Text color={theme.muted}>{label}</Text></Box>
          <Text color={theme.text}>{value}</Text>
        </Box>
      ))}
      {step.brew ? <Text> </Text> : null}
      {step.brew ? <Text color={theme.mark}>Homebrew will install or upgrade llama.cpp</Text> : null}
      <Text> </Text>
      <Text><Text color={theme.accent} bold>enter</Text><Text color={theme.text}> install   </Text><Text color={theme.accent} bold>esc</Text><Text color={theme.text}> back</Text></Text>
    </Dialog>
  );
}
