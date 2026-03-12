import React, { useRef, useState } from "react";
import type { InkKeyLike, InkRuntime } from "./runtime";

interface HumanInputProps {
  readonly ui: Pick<InkRuntime, "Box" | "Text" | "TextInput" | "useInput">;
  readonly requestId: number;
  readonly promptText: string;
  readonly onSubmit: (value: string) => void;
}

function normalizePastedSubmit(input: string): string | null {
  if (input.length <= 1 || !/[\r\n]/.test(input)) {
    return null;
  }

  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export default function HumanInput({
  ui,
  requestId,
  promptText,
  onSubmit,
}: HumanInputProps): React.JSX.Element {
  const { Box, Text, TextInput, useInput } = ui;
  const [value, setValue] = useState("");
  const skipNextSubmitRef = useRef(false);

  useInput((input: string, _key: InkKeyLike) => {
    const pastedSubmit = normalizePastedSubmit(input);
    if (pastedSubmit === null) {
      return;
    }

    skipNextSubmitRef.current = true;
    setValue("");
    onSubmit(pastedSubmit);
  });

  return (
    <Box key={requestId} flexDirection="column">
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
          onSubmit={(answer) => {
            if (skipNextSubmitRef.current) {
              skipNextSubmitRef.current = false;
              return;
            }

            setValue("");
            onSubmit(answer.trim());
          }}
        />
      </Box>
      <Text dimColor>{"  Enter sends · Ctrl+D exits"}</Text>
    </Box>
  );
}
