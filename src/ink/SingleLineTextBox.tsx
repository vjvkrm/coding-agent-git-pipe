import React from "react";
import type { InkRuntime } from "./runtime";
import { normalizeSingleLineInput } from "./normalizeSingleLineInput";

interface SingleLineTextBoxProps {
  readonly ui: Pick<InkRuntime, "Box" | "Text" | "TextInput">;
  readonly prefixText: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly accentColor?: string;
}

export default function SingleLineTextBox({
  ui,
  prefixText,
  value,
  onChange,
  onSubmit,
  accentColor = "cyan",
}: SingleLineTextBoxProps): React.JSX.Element {
  const { Box, Text, TextInput } = ui;

  return (
    <Box
      borderStyle="round"
      borderColor={accentColor}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="row"
    >
      <Text bold color={accentColor}>
        {prefixText}
      </Text>
      <Box flexGrow={1} minWidth={1}>
        <TextInput
          focus
          showCursor
          highlightPastedText
          value={value}
          onChange={(nextValue) => {
            onChange(normalizeSingleLineInput(nextValue));
          }}
          onSubmit={onSubmit}
        />
      </Box>
    </Box>
  );
}
