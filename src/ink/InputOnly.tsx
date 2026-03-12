import React from "react";
import type { InkKeyLike, InkRuntime } from "./runtime";

interface InputOnlyProps {
  readonly ui: Pick<InkRuntime, "Box" | "Text" | "TextInput" | "useInput">;
  readonly promptText: string;
  readonly onSubmit: (value: string) => void;
}

/** Minimal Ink component: just a bordered text input, mounted only during askHumanInput. */
export default function InputOnly({
  ui: inkUi,
  promptText,
  onSubmit,
}: InputOnlyProps): React.JSX.Element {
  const { Box, Text, TextInput, useInput } = inkUi;
  const [value, setValue] = React.useState("");

  useInput((input: string, key: InkKeyLike) => {
    if (key.ctrl && input === "c") {
      process.kill(process.pid, "SIGINT");
    }
  });

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingLeft={1}
      paddingRight={1}
    >
      <Text>{promptText}</Text>
      <TextInput
        focus
        showCursor
        value={value}
        onChange={setValue}
        onSubmit={(answer: string) => {
          setValue("");
          onSubmit(answer.trim());
        }}
      />
    </Box>
  );
}
