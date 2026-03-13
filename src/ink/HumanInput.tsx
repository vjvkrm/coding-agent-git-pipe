import React, { useState } from "react";
import type { InkRuntime } from "./runtime";
import SingleLineTextBox from "./SingleLineTextBox";

interface HumanInputProps {
  readonly ui: Pick<InkRuntime, "Box" | "Text" | "TextInput">;
  readonly requestId: number;
  readonly promptText: string;
  readonly onSubmit: (value: string) => void;
}

export default function HumanInput({
  ui,
  requestId,
  promptText,
  onSubmit,
}: HumanInputProps): React.JSX.Element {
  const { Box, Text, TextInput } = ui;
  const [value, setValue] = useState("");

  return (
    <Box key={requestId} flexDirection="column">
      <SingleLineTextBox
        ui={{ Box, Text, TextInput }}
        prefixText={promptText}
        value={value}
        onChange={setValue}
        onSubmit={(answer) => {
          setValue("");
          onSubmit(answer.trim());
        }}
      />
      <Text dimColor>{"  Enter sends"}</Text>
    </Box>
  );
}
