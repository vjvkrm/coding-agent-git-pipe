import React from "react";
import { parseContractOutput } from "./parser";
import { AgentName, HumanInputPayload, StepPromptScope, TaskMode, UiMode } from "./types";
import * as ui from "./ui";
import InputOnly from "./ink/InputOnly";
import { InkInstance, loadInkRuntime, shouldUseInkDebugMode } from "./ink/runtime";

type StreamName = "stdout" | "stderr";
type EffectiveUiMode = Exclude<UiMode, "auto">;

export interface RunBannerParams {
  version?: string;
  task: string;
  primaryAgent: AgentName;
  maxHops: number;
  timeoutMs: number;
  discussionEnabled: boolean;
  taskMode?: TaskMode;
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

function resolvePromptText(promptText?: string): string {
  return typeof promptText === "string" && promptText !== "" ? promptText : "Reply > ";
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

interface FullDisplayContract extends DisplayContract {
  next_action?: string;
  to?: string;
  review_verdict?: string;
}

function tryParseFullContract(text: string): FullDisplayContract | null {
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
          .map((q) =>
            q && typeof q === "object" && !Array.isArray(q) &&
            typeof (q as Record<string, unknown>).text === "string"
              ? String((q as Record<string, unknown>).text).trim()
              : ""
          )
          .filter((q): q is string => q !== "")
      : [];

    return {
      message,
      questions,
      next_action: typeof record.next_action === "string" ? record.next_action : undefined,
      to: typeof record.to === "string" ? record.to : undefined,
      review_verdict: typeof record.review_verdict === "string" ? record.review_verdict : undefined,
    };
  } catch {
    return null;
  }
}

function formatContractBrief(contract: FullDisplayContract): string {
  const action = contract.to || contract.next_action || "unknown";
  const parts: string[] = [];

  if (contract.review_verdict) {
    const icon = contract.review_verdict === "approve" ? "\x1b[32m\u2713\x1b[0m" : "\x1b[33m\u21bb\x1b[0m";
    parts.push(`${icon} ${contract.review_verdict}`);
  }

  parts.push(`\x1b[2m\u2192\x1b[0m ${action}`);

  const msgClipped = contract.message.length > 120
    ? contract.message.slice(0, 117) + "..."
    : contract.message;
  if (msgClipped) {
    parts.push(`\x1b[2m\u2502\x1b[0m ${msgClipped}`);
  }

  return parts.join(" ");
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

function extractVisibleAgentTextForTui(raw: string): string {
  const contractStartIndex = findContractStartIndex(raw);
  if (contractStartIndex < 0) {
    return raw;
  }

  const beforeContract = raw.slice(0, contractStartIndex).trimEnd();
  const contractText = raw.slice(contractStartIndex);
  const fullContract = tryParseFullContract(contractText);

  if (!fullContract) {
    // Contract block found but can't parse yet (still streaming) — hide the partial block
    return beforeContract;
  }

  const brief = formatContractBrief(fullContract);
  return beforeContract !== "" ? `${beforeContract}\n${brief}` : brief;
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

  if (typeof payload.heading === "string" && payload.heading.trim() !== "") {
    lines.push(payload.heading.trim());
  }

  if (
    payload.showMessage !== false &&
    typeof payload.message === "string" &&
    payload.message.trim() !== ""
  ) {
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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const SPINNER_IDLE_THRESHOLD_MS = 1000;

/**
 * Hybrid TUI surface: writes all output directly to stdout (scrolling),
 * uses \r-based spinner, and mounts Ink ONLY for interactive human input.
 */
class InkRunSurface implements RunSurface {
  readonly mode = "tui" as const;
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly stderr: NodeJS.WriteStream;
  private readonly rawAgentText = new Map<string, string>();
  private readonly prevVisibleLen = new Map<string, number>();
  private readonly writers = new Map<string, (chunk: string) => void>();
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private spinnerVisible = false;
  private atBol = true;
  private lastOutputAt = Date.now();
  private stopped = false;

  constructor(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;

    this.spinnerTimer = setInterval(() => this.tickSpinner(), SPINNER_INTERVAL_MS);
  }

  startRun(params: RunBannerParams): void {
    this.eraseSpinner();
    writeLine(this.stdout, ui.runBanner(params));
  }

  startStep(stepId: number, agent: AgentName, scope: StepPromptScope, timeoutMs: number): void {
    this.eraseSpinner();
    // Clear raw tracking for previous step's agent outputs
    this.rawAgentText.clear();
    this.prevVisibleLen.clear();
    this.writers.clear();
    writeLine(this.stdout, ui.stepBanner(stepId, agent, scope, timeoutMs));
  }

  note(text: string, stream: StreamName = "stdout"): void {
    this.eraseSpinner();
    const target = stream === "stderr" ? this.stderr : this.stdout;
    writeLine(target, text);
    this.atBol = true;
    this.lastOutputAt = Date.now();
  }

  writeAgentChunk(
    agent: AgentName,
    scope: StepPromptScope | string,
    chunk: string,
    stream: StreamName = "stdout"
  ): void {
    this.eraseSpinner();
    if (chunk === "") return;

    const key = `${agent}:${scope}:${stream}`;

    // Accumulate raw text
    const prevRaw = this.rawAgentText.get(key) || "";
    const nextRaw = prevRaw + chunk;
    this.rawAgentText.set(key, nextRaw);

    // Filter contracts
    const visibleText = stream === "stderr"
      ? nextRaw
      : extractVisibleAgentTextForTui(nextRaw);

    // Compute delta: what new visible text to output
    const prevLen = this.prevVisibleLen.get(key) || 0;

    if (visibleText.length >= prevLen) {
      // Visible text grew or stayed same — output only the new part
      const delta = visibleText.slice(prevLen);
      if (delta !== "") {
        const writerKey = `${key}:writer`;
        let writer = this.writers.get(writerKey);
        if (!writer) {
          writer = ui.createColoredPrefixedWriter(
            stream === "stderr" ? this.stderr : this.stdout,
            agent,
            scope,
            stream
          );
          this.writers.set(writerKey, writer);
        }
        writer(delta);
      }
    }
    // If visible text shrank (contract detected), we don't output anything new
    // — the partial contract text already printed is OK, the brief will appear
    // if/when the orchestrator outputs the contract message after parsing.

    this.prevVisibleLen.set(key, visibleText.length);
    this.lastOutputAt = Date.now();
    if (chunk.length > 0) {
      this.atBol = chunk.endsWith("\n");
    }
  }

  done(message: string): void {
    this.eraseSpinner();
    writeLine(this.stdout, ui.doneMessage(message));
  }

  async askHumanInput(
    payload: HumanInputPayload,
    fallback: (payload: HumanInputPayload) => Promise<string>
  ): Promise<string> {
    if (!this.stdin.isTTY || !this.stdout.isTTY) {
      return fallback(payload);
    }

    this.eraseSpinner();

    const detailLines = formatHumanPromptDetails(payload);
    if (detailLines.length > 0) {
      writeLine(this.stdout, detailLines.join("\n"));
    }

    // Mount Ink just for the input widget
    const promptText = resolvePromptText(payload.promptText);
    const answer = await this.collectInputViaInk(promptText);
    return answer;
  }

  stop(): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.eraseSpinner();

    if (this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  private async collectInputViaInk(promptText: string): Promise<string> {
    const runtime = await loadInkRuntime();

    return new Promise((resolve) => {
      const debug = shouldUseInkDebugMode(this.stdout);

      let instance: InkInstance | null = null;
      let resolved = false;

      const finish = (value: string) => {
        if (resolved) return;
        resolved = true;
        if (instance) {
          instance.unmount();
          instance.cleanup();
          instance = null;
        }
        // Echo what the user typed
        writeLine(this.stdout, `${promptText}${value}`);
        this.lastOutputAt = Date.now();
        this.atBol = true;
        resolve(value);
      };

      instance = runtime.render(
        React.createElement(InputOnly, {
          ui: runtime,
          promptText,
          onSubmit: finish,
        }),
        {
          stdin: this.stdin,
          stdout: this.stdout,
          stderr: this.stderr,
          debug,
          exitOnCtrlC: false,
          patchConsole: false,
        }
      );
    });
  }

  private eraseSpinner(): void {
    if (this.spinnerVisible) {
      this.stdout.write("\r\x1b[K");
      this.spinnerVisible = false;
    }
  }

  private tickSpinner(): void {
    if (this.stopped) {
      return;
    }

    const idleMs = Date.now() - this.lastOutputAt;
    if (!this.atBol || idleMs < SPINNER_IDLE_THRESHOLD_MS) {
      return;
    }

    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
    const frame = SPINNER_FRAMES[this.spinnerFrame];
    this.stdout.write(`\r${frame} working...`);
    this.spinnerVisible = true;
  }
}

export function createRunSurface(options: CreateRunSurfaceOptions = {}): RunSurface {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const mode = resolveUiMode(options.mode, { stdin, stdout });

  if (mode === "tui") {
    return new InkRunSurface(stdin, stdout, stderr);
  }

  return new PlainRunSurface(stdout, stderr);
}
