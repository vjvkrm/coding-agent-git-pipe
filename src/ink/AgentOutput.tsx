import React from "react";
import type { InkRuntime } from "./runtime";

interface AgentOutputProps {
  readonly ui: Pick<InkRuntime, "Text">;
  readonly output: string;
}

export default function AgentOutput({ ui, output }: AgentOutputProps): React.JSX.Element | null {
  const { Text } = ui;

  if (output === "") {
    return null;
  }

  return <Text>{output}</Text>;
}
