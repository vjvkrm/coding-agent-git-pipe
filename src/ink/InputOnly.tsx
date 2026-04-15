import React from "react";
import type { InkKeyLike, InkRuntime } from "./runtime";
import { normalizeSingleLineInput } from "./normalizeSingleLineInput";

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
  const pasteBufferRef = React.useRef(false);
  const pasteTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  useInput((input: string, key: InkKeyLike) => {
    if (key.ctrl && input === "c") {
      process.kill(process.pid, "SIGINT");
    }
  });

  const handleChange = React.useCallback((nextValue: string) => {
    const hasPastedNewlines = /[\r\n]/.test(nextValue);
    if (hasPastedNewlines) {
      pasteBufferRef.current = true;
      // Clear paste flag after a short delay (paste arrives in one burst)
      if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current);
      pasteTimerRef.current = setTimeout(() => {
        pasteBufferRef.current = false;
      }, 100);
    }
    setValue(normalizeSingleLineInput(nextValue));
  }, []);

  const handleSubmit = React.useCallback((submitted: string) => {
    // If we're in a paste burst, ignore the submit (it's a pasted newline, not Enter)
    if (pasteBufferRef.current) {
      return;
    }
    const trimmed = submitted.trim();
    setValue("");
    onSubmit(trimmed);
  }, [onSubmit]);

  return (
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
      >
        <Text bold color="cyan">
          {promptText}
        </Text>
        <Box flexGrow={1} minWidth={1}>
          <TextInput
            focus
            showCursor
            highlightPastedText
            value={value}
            onChange={handleChange}
            onSubmit={handleSubmit}
          />
        </Box>
      </Box>
    </Box>
  );
}
