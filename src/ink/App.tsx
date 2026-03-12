import React, { useSyncExternalStore } from "react";
import { AgentName, HumanInputPayload, StepPromptScope } from "../types";
import type { RunBannerParams } from "../run-ui";
import type { InkKeyLike, InkRuntime } from "./runtime";
import RunView from "./RunView";

export interface InkStepState {
  readonly stepId: number;
  readonly agent: AgentName;
  readonly scope: StepPromptScope;
  readonly timeoutMs: number;
  readonly bannerText: string;
}

export interface InkInputRequestState {
  readonly id: number;
  readonly payload: HumanInputPayload;
  readonly promptText: string;
}

export interface InkAppState {
  readonly banner: RunBannerParams | null;
  readonly steps: readonly InkStepState[];
  readonly committedLines: readonly string[];
  readonly liveOutput: string;
  readonly spinnerFrame: string | null;
  readonly inputRequest: InkInputRequestState | null;
  readonly doneMessage: string | null;
}

export interface InkAppStore {
  getSnapshot(): InkAppState;
  subscribe(listener: () => void): () => void;
}

interface AppProps {
  readonly store: InkAppStore;
  readonly ui: Pick<InkRuntime, "Box" | "Text" | "Static" | "TextInput" | "useInput">;
  readonly onSubmitHumanInput: (value: string) => void;
}

export default function App({ store, ui, onSubmitHumanInput }: AppProps): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  // Handle Ctrl+C to forward SIGINT during runs
  ui.useInput((input: string, key: InkKeyLike) => {
    if (key.ctrl && input === "c") {
      process.kill(process.pid, "SIGINT");
    }
  });

  return <RunView ui={ui} state={state} onSubmitHumanInput={onSubmitHumanInput} />;
}
