import React from "react";
import type { InkRuntime } from "./runtime";

interface SpinnerProps {
  readonly ui: Pick<InkRuntime, "Text">;
  readonly frame: string;
}

export default function Spinner({ ui, frame }: SpinnerProps): React.JSX.Element {
  const { Text } = ui;
  return <Text dimColor>{`${frame} working...`}</Text>;
}
