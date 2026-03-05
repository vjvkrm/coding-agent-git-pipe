function tryParseJson(rawJson: string): unknown {
  try {
    return JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`Invalid JSON contract: ${(error as Error).message}`);
  }
}

export function parseContractOutput(outputText: string): unknown {
  if (typeof outputText !== "string") {
    throw new Error("Agent output must be a string");
  }

  const trimmed = outputText.trim();
  if (trimmed.length === 0) {
    throw new Error("Agent output is empty");
  }

  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)\s*```\s*$/i);
  if (fencedMatch && fencedMatch[1]) {
    return tryParseJson(fencedMatch[1].trim());
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return tryParseJson(trimmed);
  }

  throw new Error("Could not find a final ```json ... ``` contract block");
}
