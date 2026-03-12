import React, { useRef, useState } from "react";
import type { InkKeyLike, InkRuntime } from "./runtime";

interface ReplAppProps {
  readonly ui: Pick<InkRuntime, "Box" | "Text" | "TextInput" | "useInput">;
  readonly bannerText: string;
  readonly noticeText: string | null;
  readonly onSubmit: (value: string, remainder?: string) => void;
  readonly onExit: () => void;
}

function splitPastedSubmission(
  currentValue: string,
  input: string
): { value: string; remainder: string | undefined } | null {
  if (input.length <= 1 || !/[\r\n]/.test(input)) {
    return null;
  }

  const normalized = `${currentValue}${input}`.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstBreak = normalized.indexOf("\n");
  if (firstBreak < 0) {
    return null;
  }

  const value = normalized.slice(0, firstBreak);
  const remainder = normalized.slice(firstBreak + 1);
  return {
    value,
    remainder: remainder !== "" ? remainder : undefined,
  };
}

export default function ReplApp({
  ui,
  bannerText,
  noticeText,
  onSubmit,
  onExit,
}: ReplAppProps): React.JSX.Element {
  const { Box, Text, TextInput, useInput } = ui;
  const [value, setValue] = useState("");
  const valueRef = useRef("");

  useInput((input: string, key: InkKeyLike) => {
    if (key.ctrl && input === "d") {
      onExit();
      return;
    }

    const pastedSubmission = splitPastedSubmission(valueRef.current, input);
    if (!pastedSubmission) {
      return;
    }

    valueRef.current = "";
    setValue("");
    onSubmit(pastedSubmission.value, pastedSubmission.remainder);
  });

  return (
    <Box flexDirection="column">
      <Text>{bannerText}</Text>
      {noticeText ? <Text>{noticeText}</Text> : null}
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingLeft={1}
        paddingRight={1}
      >
        <Text bold>{"> "}</Text>
        <TextInput
          focus
          showCursor
          value={value}
          onChange={(nextValue) => {
            valueRef.current = nextValue;
            setValue(nextValue);
          }}
          onSubmit={(answer) => {
            valueRef.current = "";
            setValue("");
            onSubmit(answer);
          }}
        />
      </Box>
    </Box>
  );
}
