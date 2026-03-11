import path from "node:path";
import readline from "node:readline";
import { parseContractOutput } from "./parser";
import { AgentName, HumanInputPayload, StepPromptScope, UiMode } from "./types";
import * as ui from "./ui";

type StreamName = "stdout" | "stderr";
type EffectiveUiMode = Exclude<UiMode, "auto">;
type StepStatus = "running" | "done" | "blocked";
type TranscriptKind = "system" | "agent" | "stderr" | "human";

export interface RunBannerParams {
  version?: string;
  task: string;
  primaryAgent: AgentName;
  maxHops: number;
  timeoutMs: number;
  discussionEnabled: boolean;
  reviewGate: boolean;
  logPath: string;
  lockPath: string;
  runId: string;
  cwd: string;
  noProgressHops: number;
}

export interface RunSurface {
  readonly mode: EffectiveUiMode;
  startRun(params: RunBannerParams): void;
  startStep(stepId: number, agent: AgentName, scope: StepPromptScope, timeoutMs: number): void;
  note(text: string, stream?: StreamName): void;
  writeAgentChunk(
    agent: AgentName,
    scope: StepPromptScope | string,
    chunk: string,
    stream?: StreamName
  ): void;
  done(message: string): void;
  askHumanInput(
    payload: HumanInputPayload,
    fallback: (payload: HumanInputPayload) => Promise<string>
  ): Promise<string>;
  stop(): void;
}

interface CreateRunSurfaceOptions {
  mode?: UiMode | null;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

interface StepState {
  id: number;
  agent: AgentName;
  scope: StepPromptScope;
  timeoutMs: number;
  status: StepStatus;
}

interface TranscriptEntry {
  kind: TranscriptKind;
  label: string;
  text: string;
  mergeKey?: string;
}

interface DisplayContract {
  message: string;
  questions: string[];
}

function writeLine(target: NodeJS.WriteStream, value: string): void {
  target.write(value);
  if (!value.endsWith("\n")) {
    target.write("\n");
  }
}

function clipLine(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (value.length <= width) {
    return value;
  }

  if (width <= 1) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 1)}…`;
}

function padLine(value: string, width: number): string {
  const clipped = clipLine(value, width);
  return clipped.padEnd(width, " ");
}

function wrapLine(value: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }

  if (value === "") {
    return [""];
  }

  const words = value.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (word === "") {
      continue;
    }

    if (word.length > width) {
      if (current !== "") {
        lines.push(current);
        current = "";
      }
      for (let offset = 0; offset < word.length; offset += width) {
        lines.push(word.slice(offset, offset + width));
      }
      continue;
    }

    if (current === "") {
      current = word;
      continue;
    }

    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current !== "") {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

function wrapTextBlock(value: string, width: number): string[] {
  return value
    .split(/\r?\n/)
    .flatMap((line) => wrapLine(line, width));
}

function normalizeNoteText(value: string): string {
  return ui.stripAnsi(value).replace(/\r/g, "").replace(/^\n+|\n+$/g, "");
}

function normalizeChunkText(value: string): string {
  return ui.stripAnsi(value).replace(/\r/g, "");
}

function resolvePromptText(): string {
  return "Reply > ";
}

function findContractStartIndex(text: string): number {
  const fencedIndex = text.lastIndexOf("```json");
  if (fencedIndex >= 0) {
    return fencedIndex;
  }

  const contractKeyIndex = text.lastIndexOf('"contract_version"');
  if (contractKeyIndex < 0) {
    return -1;
  }

  return text.lastIndexOf("{", contractKeyIndex);
}

function tryParseDisplayContract(text: string): DisplayContract | null {
  try {
    const parsed = parseContractOutput(text);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("contract_version" in parsed)
    ) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message.trim() : "";
    const questions = Array.isArray(record.questions)
      ? record.questions
          .map((question) =>
            question &&
            typeof question === "object" &&
            !Array.isArray(question) &&
            typeof (question as Record<string, unknown>).text === "string"
              ? String((question as Record<string, unknown>).text).trim()
              : ""
          )
          .filter((question): question is string => question !== "")
      : [];

    return { message, questions };
  } catch (_error) {
    return null;
  }
}

function formatContractSummary(contract: DisplayContract): string {
  const lines: string[] = [];
  if (contract.message !== "") {
    lines.push(contract.message);
  }

  for (const question of contract.questions) {
    lines.push(`Question: ${question}`);
  }

  return lines.join("\n\n");
}

export function extractVisibleAgentText(raw: string): string {
  const contractStartIndex = findContractStartIndex(raw);
  if (contractStartIndex < 0) {
    return raw;
  }

  const beforeContract = raw.slice(0, contractStartIndex).trimEnd();
  const contractText = raw.slice(contractStartIndex);
  const parsedContract = tryParseDisplayContract(contractText);

  if (!parsedContract) {
    return beforeContract;
  }

  if (beforeContract !== "") {
    return beforeContract;
  }

  return formatContractSummary(parsedContract);
}

function normalizeHumanFooter(footer: string): string {
  const trimmed = footer.trim();
  if (trimmed === "") {
    return "";
  }

  return trimmed.replace('Reply with "/finish" to end the run immediately.', "/finish ends the run.");
}

function formatHumanPromptDetails(payload: HumanInputPayload): string[] {
  const lines: string[] = [];

  if (typeof payload.message === "string" && payload.message.trim() !== "") {
    lines.push(payload.message.trim());
  }

  if (Array.isArray(payload.questions) && payload.questions.length > 0) {
    for (const question of payload.questions) {
      if (question.text.trim() !== "") {
        lines.push(`- ${question.text.trim()}`);
      }
    }
  }

  const footer = normalizeHumanFooter(typeof payload.footer === "string" ? payload.footer : "");
  if (footer !== "") {
    lines.push(footer);
  }

  return lines;
}

function formatElapsed(startedAt: number): string {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function stepStatusLabel(status: StepStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "blocked":
      return "waiting";
    case "done":
      return "done";
  }
}

function stepStatusSymbol(status: StepStatus): string {
  switch (status) {
    case "running":
      return ">";
    case "blocked":
      return "?";
    case "done":
      return "*";
  }
}

export function resolveUiMode(
  requested: UiMode | null | undefined,
  streams: Pick<CreateRunSurfaceOptions, "stdin" | "stdout"> = {}
): EffectiveUiMode {
  if (requested === "plain" || requested === "tui") {
    return requested;
  }

  const stdin = streams.stdin || process.stdin;
  const stdout = streams.stdout || process.stdout;
  return stdin.isTTY && stdout.isTTY ? "tui" : "plain";
}

class PlainRunSurface implements RunSurface {
  readonly mode = "plain" as const;
  private readonly stdout: NodeJS.WriteStream;
  private readonly stderr: NodeJS.WriteStream;
  private readonly writers = new Map<string, (chunk: string) => void>();

  constructor(stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream) {
    this.stdout = stdout;
    this.stderr = stderr;
  }

  startRun(params: RunBannerParams): void {
    writeLine(this.stdout, ui.runBanner(params));
  }

  startStep(stepId: number, agent: AgentName, scope: StepPromptScope, timeoutMs: number): void {
    writeLine(this.stdout, ui.stepBanner(stepId, agent, scope, timeoutMs));
  }

  note(text: string, stream: StreamName = "stdout"): void {
    const target = stream === "stderr" ? this.stderr : this.stdout;
    writeLine(target, text);
  }

  writeAgentChunk(
    agent: AgentName,
    scope: StepPromptScope | string,
    chunk: string,
    stream: StreamName = "stdout"
  ): void {
    const key = `${agent}:${scope}:${stream}`;
    let writer = this.writers.get(key);
    if (!writer) {
      writer = ui.createColoredPrefixedWriter(
        stream === "stderr" ? this.stderr : this.stdout,
        agent,
        scope,
        stream
      );
      this.writers.set(key, writer);
    }
    writer(chunk);
  }

  done(message: string): void {
    writeLine(this.stdout, ui.doneMessage(message));
  }

  askHumanInput(
    payload: HumanInputPayload,
    fallback: (payload: HumanInputPayload) => Promise<string>
  ): Promise<string> {
    return fallback(payload);
  }

  stop(): void {}
}

class TuiRunSurface implements RunSurface {
  readonly mode = "tui" as const;
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly stderr: NodeJS.WriteStream;
  private readonly steps: StepState[] = [];
  private readonly transcript: TranscriptEntry[] = [];
  private readonly streamRawText = new Map<string, string>();
  private readonly resizeHandler = () => this.render();
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private readonly keypressHandler = (_text: string, key: readline.Key) => {
    if (key.ctrl && key.name === "c") {
      this.stop();
      process.kill(process.pid, "SIGINT");
      return;
    }

    if (!this.pendingAnswer) {
      return;
    }

    if (key.name === "return") {
      const answer = this.inputBuffer.trim();
      const resolve = this.pendingAnswer;
      this.pendingAnswer = null;
      this.awaitingHumanInput = null;
      this.statusText = "Human input captured";
      this.inputBuffer = "";
      this.appendTranscript({
        kind: "human",
        label: "You",
        text: answer === "" ? "(empty response)" : answer,
      });
      resolve(answer);
      return;
    }

    if (key.name === "backspace") {
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      this.render();
      return;
    }

    if (key.name === "escape") {
      this.inputBuffer = "";
      this.render();
      return;
    }

    if (typeof key.sequence === "string" && !key.ctrl && !key.meta) {
      this.inputBuffer += key.sequence;
      this.render();
    }
  };

  private runInfo: RunBannerParams | null = null;
  private currentStepId: number | null = null;
  private statusText = "Starting";
  private awaitingHumanInput: HumanInputPayload | null = null;
  private pendingAnswer: ((answer: string) => void) | null = null;
  private inputBuffer = "";
  private stopped = false;
  private rawModeEnabled = false;
  private readonly startedAt = Date.now();

  constructor(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;

    readline.emitKeypressEvents(this.stdin);
    if (this.stdin.isTTY) {
      this.stdin.setRawMode(true);
      this.rawModeEnabled = true;
    }
    this.stdin.on("keypress", this.keypressHandler);
    this.stdout.on("resize", this.resizeHandler);
    this.stdout.write("\x1b[?1049h\x1b[?25l");
    this.refreshTimer = setInterval(() => this.render(), 1000);
    this.render();
  }

  startRun(params: RunBannerParams): void {
    this.runInfo = params;
    this.statusText = "Run started";
    this.render();
  }

  startStep(stepId: number, agent: AgentName, scope: StepPromptScope, timeoutMs: number): void {
    this.completeCurrentStep("done");
    this.currentStepId = stepId;
    this.steps.push({
      id: stepId,
      agent,
      scope,
      timeoutMs,
      status: "running",
    });
    this.statusText = `Running step ${stepId} (${agent}/${scope})`;
    this.appendTranscript({
      kind: "system",
      label: "System",
      text: `Step ${stepId} started · ${agent} · ${scope} · ${Math.round(timeoutMs / 1000)}s`,
    });
  }

  note(text: string, stream: StreamName = "stdout"): void {
    const normalized = normalizeNoteText(text);
    if (normalized === "") {
      return;
    }

    this.appendTranscript({
      kind: stream === "stderr" ? "stderr" : "system",
      label: stream === "stderr" ? "stderr" : "System",
      text: normalized,
    });
  }

  writeAgentChunk(
    agent: AgentName,
    scope: StepPromptScope | string,
    chunk: string,
    stream: StreamName = "stdout"
  ): void {
    const normalized = normalizeChunkText(chunk);
    if (normalized === "") {
      return;
    }

    this.statusText =
      stream === "stderr"
        ? `${agent}/${scope} emitted stderr`
        : `${agent}/${scope} streaming`;

    const mergeKey = `${agent}:${scope}:${stream}`;
    const nextRawText = `${this.streamRawText.get(mergeKey) || ""}${normalized}`;
    this.streamRawText.set(mergeKey, nextRawText);

    const visibleText =
      stream === "stderr" ? nextRawText : extractVisibleAgentText(nextRawText);

    this.upsertTranscript({
      kind: stream === "stderr" ? "stderr" : "agent",
      label: stream === "stderr" ? `${agent} · ${scope} · stderr` : `${agent} · ${scope}`,
      text: visibleText,
      mergeKey,
    });
  }

  done(message: string): void {
    this.completeCurrentStep("done");
    this.statusText = "Run completed";
    this.appendTranscript({
      kind: "system",
      label: "Done",
      text: message,
    });
  }

  async askHumanInput(
    payload: HumanInputPayload,
    fallback: (payload: HumanInputPayload) => Promise<string>
  ): Promise<string> {
    if (!this.stdin.isTTY || !this.stdout.isTTY) {
      return fallback(payload);
    }

    this.completeCurrentStep("blocked");
    this.awaitingHumanInput = payload;
    this.statusText = "Waiting for your reply";
    this.inputBuffer = "";
    this.render();

    return new Promise((resolve) => {
      this.pendingAnswer = resolve;
      this.render();
    });
  }

  stop(): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    clearInterval(this.refreshTimer);
    this.stdout.off("resize", this.resizeHandler);
    this.stdin.off("keypress", this.keypressHandler);
    if (this.rawModeEnabled && this.stdin.isTTY) {
      this.stdin.setRawMode(false);
    }
    this.stdout.write("\x1b[?25h\x1b[?1049l");
    if (this.awaitingHumanInput && this.pendingAnswer) {
      const resolve = this.pendingAnswer;
      this.pendingAnswer = null;
      resolve("");
    }
  }

  private completeCurrentStep(status: StepStatus): void {
    if (this.currentStepId === null) {
      return;
    }

    const current = this.steps.find((step) => step.id === this.currentStepId);
    if (current && current.status !== "done") {
      current.status = status;
    }
  }

  private appendTranscript(entry: TranscriptEntry): void {
    const last = this.transcript[this.transcript.length - 1];
    if (
      entry.mergeKey &&
      last &&
      last.mergeKey === entry.mergeKey &&
      last.kind === entry.kind &&
      last.label === entry.label
    ) {
      last.text += entry.text;
    } else {
      this.transcript.push(entry);
      if (this.transcript.length > 200) {
        this.transcript.splice(0, this.transcript.length - 200);
      }
    }
    this.render();
  }

  private upsertTranscript(entry: TranscriptEntry): void {
    const index = this.findTranscriptIndex(entry.mergeKey);
    const normalizedText = entry.text.trim();

    if (normalizedText === "") {
      if (index >= 0) {
        this.transcript.splice(index, 1);
      }
      this.render();
      return;
    }

    if (index >= 0) {
      this.transcript[index] = { ...entry, text: normalizedText };
    } else {
      this.transcript.push({ ...entry, text: normalizedText });
      if (this.transcript.length > 200) {
        this.transcript.splice(0, this.transcript.length - 200);
      }
    }

    this.render();
  }

  private findTranscriptIndex(mergeKey: string | undefined): number {
    if (!mergeKey) {
      return -1;
    }

    for (let index = 0; index < this.transcript.length; index += 1) {
      if (this.transcript[index].mergeKey === mergeKey) {
        return index;
      }
    }

    return -1;
  }

  private render(): void {
    if (this.stopped) {
      return;
    }

    const width = Math.max(this.stdout.columns || 100, 72);
    const height = Math.max(this.stdout.rows || 32, 20);
    const leftWidth = Math.min(30, Math.max(22, Math.floor(width * 0.26)));
    const rightWidth = Math.max(24, width - leftWidth - 3);

    const headerLines = this.buildHeader(width);
    const footerLines = this.buildFooter(width);
    const separator = "─".repeat(width);
    const bodyHeight = Math.max(6, height - headerLines.length - footerLines.length - 1);
    const stepLines = this.buildStepLines(leftWidth, bodyHeight);
    const transcriptLines = this.buildTranscriptLines(rightWidth, bodyHeight);

    const frame: string[] = [];
    frame.push("\x1b[H\x1b[2J");
    frame.push(...headerLines);
    frame.push(separator);

    for (let index = 0; index < bodyHeight; index += 1) {
      frame.push(
        `${padLine(stepLines[index] || "", leftWidth)} │ ${padLine(
          transcriptLines[index] || "",
          rightWidth
        )}`
      );
    }

    frame.push(...footerLines);
    this.stdout.write(`${frame.join("\n")}\n`);
  }

  private buildHeader(width: number): string[] {
    if (!this.runInfo) {
      return [clipLine("agent-pipe live dashboard", width), clipLine(this.statusText, width)];
    }

    const featureList = [
      this.runInfo.discussionEnabled ? "discuss" : null,
      this.runInfo.reviewGate ? "review-gate" : null,
    ]
      .filter((value): value is string => value !== null)
      .join(", ");

    return [
      clipLine(
        `agent-pipe live dashboard · ${path.basename(this.runInfo.cwd)} · ${this.statusText}`,
        width
      ),
      clipLine(`task · ${this.runInfo.task}`, width),
      clipLine(
        `run ${this.runInfo.runId} · primary ${this.runInfo.primaryAgent} · elapsed ${formatElapsed(
          this.startedAt
        )}`,
        width
      ),
      clipLine(
        `max hops ${this.runInfo.maxHops} · timeout ${Math.round(
          this.runInfo.timeoutMs / 1000
        )}s · no-progress ${this.runInfo.noProgressHops} · features ${featureList || "none"}`,
        width
      ),
    ];
  }

  private buildStepLines(width: number, height: number): string[] {
    const lines = [clipLine("Steps", width)];
    if (this.steps.length === 0) {
      lines.push(clipLine("Waiting to start", width));
      while (lines.length < height) {
        lines.push("");
      }
      return lines.slice(0, height);
    }

    for (const step of this.steps) {
      lines.push(
        clipLine(
          `${stepStatusSymbol(step.status)} ${String(step.id).padStart(2, "0")} ${step.agent} ${step.scope}`,
          width
        )
      );
      lines.push(
        clipLine(
          `   ${stepStatusLabel(step.status)} · ${Math.round(step.timeoutMs / 1000)}s`,
          width
        )
      );
    }

    while (lines.length < height) {
      lines.push("");
    }

    return lines.slice(-height);
  }

  private buildTranscriptLines(width: number, height: number): string[] {
    const lines = ["Transcript"];

    if (this.transcript.length === 0) {
      lines.push("Waiting for agent output");
      while (lines.length < height) {
        lines.push("");
      }
      return lines.slice(0, height);
    }

    for (const entry of this.transcript) {
      lines.push(clipLine(`[${entry.label}]`, width));
      const wrapped = wrapTextBlock(entry.text, Math.max(1, width - 2));
      for (const line of wrapped) {
        lines.push(clipLine(`  ${line}`, width));
      }
      lines.push("");
    }

    while (lines.length < height) {
      lines.push("");
    }

    return lines.slice(-height);
  }

  private buildFooter(width: number): string[] {
    const lines = ["─".repeat(width)];
    if (!this.awaitingHumanInput) {
      lines.push(clipLine(`status · ${this.statusText}`, width));
      lines.push(clipLine("Ctrl+C exits", width));
      return lines;
    }

    lines.push(clipLine("Reply", width));
    const detailLines = formatHumanPromptDetails(this.awaitingHumanInput).flatMap((line) =>
      wrapTextBlock(line, width)
    );
    const visibleDetails = detailLines.slice(-3);
    lines.push(...visibleDetails.map((line) => clipLine(line, width)));
    const promptText = resolvePromptText();
    lines.push(clipLine(`${promptText}${this.inputBuffer}`, width));
    lines.push(clipLine("Enter sends · Esc clears · Ctrl+C exits", width));
    return lines;
  }
}

export function createRunSurface(options: CreateRunSurfaceOptions = {}): RunSurface {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const mode = resolveUiMode(options.mode, { stdin, stdout });

  if (mode === "tui") {
    return new TuiRunSurface(stdin, stdout, stderr);
  }

  return new PlainRunSurface(stdout, stderr);
}
