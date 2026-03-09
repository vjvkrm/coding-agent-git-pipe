function tryParseJson(rawJson: string): unknown {
  try {
    return JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`Invalid JSON contract: ${(error as Error).message}`);
  }
}

function safeParseJson(rawJson: string): unknown | null {
  try {
    return JSON.parse(rawJson);
  } catch (_error) {
    return null;
  }
}

function collectStringValues(value: unknown, result: string[]): void {
  if (typeof value === "string") {
    result.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, result);
    }
    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  for (const nestedValue of Object.values(value as Record<string, unknown>)) {
    collectStringValues(nestedValue, result);
  }
}

function extractFencedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const pattern = /```json\s*([\s\S]*?)\s*```/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] && match[1].trim() !== "") {
      candidates.push(match[1].trim());
    }
  }
  return candidates;
}

function tryParseContractFromText(text: string): unknown | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const fencedCandidates = extractFencedJsonCandidates(trimmed);
  for (let index = fencedCandidates.length - 1; index >= 0; index -= 1) {
    const parsed = safeParseJson(fencedCandidates[index]);
    if (parsed !== null) {
      return parsed;
    }
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const parsed = safeParseJson(trimmed);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function tryParseContractFromJsonLines(text: string): unknown | null {
  const parsedLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => safeParseJson(line))
    .filter((value) => value !== null);

  if (parsedLines.length === 0) {
    return null;
  }

  for (let index = parsedLines.length - 1; index >= 0; index -= 1) {
    const parsedLine = parsedLines[index] as unknown;
    if (
      parsedLine !== null &&
      typeof parsedLine === "object" &&
      !Array.isArray(parsedLine) &&
      "contract_version" in (parsedLine as Record<string, unknown>)
    ) {
      return parsedLine;
    }
  }

  const stringCandidates: string[] = [];
  for (const parsedLine of parsedLines) {
    collectStringValues(parsedLine, stringCandidates);
  }

  for (let index = stringCandidates.length - 1; index >= 0; index -= 1) {
    const parsed = tryParseContractFromText(stringCandidates[index]);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

export function parseContractOutput(outputText: string): unknown {
  if (typeof outputText !== "string") {
    throw new Error("Agent output must be a string");
  }

  const trimmed = outputText.trim();
  if (trimmed.length === 0) {
    throw new Error("Agent output is empty");
  }

  const direct = tryParseContractFromText(trimmed);
  if (direct !== null) {
    if (typeof direct === "object") {
      return direct;
    }
    throw new Error("Invalid JSON contract: Contract must be a JSON object");
  }

  const fromJsonLines = tryParseContractFromJsonLines(trimmed);
  if (fromJsonLines !== null) {
    if (typeof fromJsonLines === "object") {
      return fromJsonLines;
    }
    throw new Error("Invalid JSON contract: Contract must be a JSON object");
  }

  const fencedCandidates = extractFencedJsonCandidates(trimmed);
  if (fencedCandidates.length > 0) {
    return tryParseJson(fencedCandidates[fencedCandidates.length - 1]);
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return tryParseJson(trimmed);
  }

  throw new Error("Could not find a contract JSON object or ```json ... ``` contract block");
}
