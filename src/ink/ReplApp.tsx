import React, { useState } from "react";
import type { InkKeyLike, InkRuntime } from "./runtime";
import SingleLineTextBox from "./SingleLineTextBox";

interface ReplAppProps {
  readonly ui: Pick<InkRuntime, "Box" | "Text" | "TextInput" | "useInput">;
  readonly bannerText: string;
  readonly noticeText: string | null;
  readonly onSubmit: (value: string) => void;
  readonly onExit: () => void;
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

  useInput((input: string, key: InkKeyLike) => {
    if (key.ctrl && input === "d") {
      onExit();
    }
  });

  return (
    <Box flexDirection="column">
      <Text>{bannerText}</Text>
      {noticeText ? <Text>{noticeText}</Text> : null}
      <SingleLineTextBox
        ui={{ Box, Text, TextInput }}
        prefixText={"> "}
        value={value}
        onChange={setValue}
        onSubmit={(answer) => {
          setValue("");
          onSubmit(answer);
        }}
      />
    </Box>
  );
}
