import React from "react";
import type { InkRuntime } from "./runtime";
import type { InkAppState } from "./App";
import HumanInput from "./HumanInput";
import Spinner from "./Spinner";

interface RunViewProps {
  readonly ui: Pick<InkRuntime, "Box" | "Text" | "Static" | "TextInput" | "useInput">;
  readonly state: InkAppState;
  readonly onSubmitHumanInput: (value: string) => void;
}

export default function RunView({
  ui,
  state,
  onSubmitHumanInput,
}: RunViewProps): React.JSX.Element {
  const { Box, Text, Static } = ui;

  return (
    <Box flexDirection="column">
      <Static items={state.committedLines}>
        {(line: unknown, index: number) => (
          <Text key={index}>{line as string}</Text>
        )}
      </Static>

      {state.liveOutput !== "" ? <Text>{state.liveOutput}</Text> : null}

      {state.inputRequest ? (
        <Box flexDirection="column" marginTop={1}>
          <HumanInput
            key={state.inputRequest.id}
            ui={ui}
            requestId={state.inputRequest.id}
            promptText={state.inputRequest.promptText}
            onSubmit={onSubmitHumanInput}
          />
        </Box>
      ) : null}

      {!state.inputRequest && state.spinnerFrame ? (
        <Box marginTop={1}>
          <Spinner ui={ui} frame={state.spinnerFrame} />
        </Box>
      ) : null}
    </Box>
  );
}
