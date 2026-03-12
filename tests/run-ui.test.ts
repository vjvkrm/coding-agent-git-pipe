import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createRunSurface, extractVisibleAgentText, resolveUiMode } from "../src/run-ui";

class FakeTtyInput extends PassThrough {
  isTTY = true;
  rawMode = false;

  setRawMode(value: boolean): this {
    this.rawMode = value;
    return this;
  }
}

class FakeTtyOutput extends PassThrough {
  isTTY = true;
  columns = 100;
  rows = 32;
  writes: string[] = [];

  override write(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ): boolean {
    this.writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));

    if (typeof encoding === "function") {
      return super.write(chunk, encoding);
    }

    return super.write(chunk, encoding, callback);
  }
}

test("resolveUiMode honors explicit mode overrides", () => {
  assert.equal(resolveUiMode("plain"), "plain");
  assert.equal(resolveUiMode("tui"), "tui");
});

test("resolveUiMode defaults to plain when tty is unavailable", () => {
  assert.equal(
    resolveUiMode(null, {
      stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: { isTTY: true } as NodeJS.WriteStream,
    }),
    "plain"
  );
});

test("resolveUiMode defaults to tui when stdin and stdout are tty", () => {
  assert.equal(
    resolveUiMode(null, {
      stdin: { isTTY: true } as NodeJS.ReadStream,
      stdout: { isTTY: true } as NodeJS.WriteStream,
    }),
    "tui"
  );
});

test("extractVisibleAgentText replaces a contract-only response with the useful summary", () => {
  const raw = [
    "```json",
    "{",
    '  "contract_version": "1",',
    '  "next_action": "ask-human",',
    '  "message": "Need the exact task before editing files.",',
    '  "questions": [{"id":"q1","text":"What should I change?"}]',
    "}",
    "```",
  ].join("\n");

  assert.equal(
    extractVisibleAgentText(raw),
    "Need the exact task before editing files.\n\nQuestion: What should I change?"
  );
});

test("extractVisibleAgentText hides an incomplete contract block from the transcript", () => {
  const raw = [
    "Thinking through the repo",
    "```json",
    "{",
    '  "contract_version": "1",',
  ].join("\n");

  assert.equal(extractVisibleAgentText(raw), "Thinking through the repo");
});

test("tui outputs step banners and agent chunks to stdout", () => {
  const stdin = new FakeTtyInput() as unknown as NodeJS.ReadStream;
  const stdout = new FakeTtyOutput() as unknown as NodeJS.WriteStream & FakeTtyOutput;
  const stderr = new FakeTtyOutput() as unknown as NodeJS.WriteStream;
  const surface = createRunSurface({
    mode: "tui",
    stdin,
    stdout,
    stderr,
  });

  try {
    surface.startStep(1, "claude", "primary", 60000);
    const stepOutput = stdout.writes.join("");
    assert.match(stepOutput, /Step/);
    assert.match(stepOutput, /Claude/i);

    stdout.writes.length = 0;
    surface.writeAgentChunk("claude", "primary", "Hello world\n");
    const chunkOutput = stdout.writes.join("");
    assert.match(chunkOutput, /Hello world/);
  } finally {
    surface.stop();
  }
});

test("tui askHumanInput returns typed answer via readline", async () => {
  const stdin = new FakeTtyInput() as unknown as NodeJS.ReadStream;
  const stdout = new FakeTtyOutput() as unknown as NodeJS.WriteStream & FakeTtyOutput;
  const stderr = new FakeTtyOutput() as unknown as NodeJS.WriteStream;
  const surface = createRunSurface({
    mode: "tui",
    stdin,
    stdout,
    stderr,
  });

  try {
    const answerPromise = surface.askHumanInput(
      {
        message: "Need input",
        questions: [{ id: "q1", text: "What changed?" }],
        footer: "",
      },
      async () => ""
    );

    // Simulate user typing a line
    (stdin as unknown as PassThrough).write("my answer\n");

    const answer = await answerPromise;
    assert.equal(answer, "my answer");
  } finally {
    surface.stop();
  }
});

test("tui done message appears in stdout", () => {
  const stdin = new FakeTtyInput() as unknown as NodeJS.ReadStream;
  const stdout = new FakeTtyOutput() as unknown as NodeJS.WriteStream & FakeTtyOutput;
  const stderr = new FakeTtyOutput() as unknown as NodeJS.WriteStream;
  const surface = createRunSurface({
    mode: "tui",
    stdin,
    stdout,
    stderr,
  });

  try {
    surface.done("Task completed successfully");
    const output = stdout.writes.join("");
    assert.match(output, /Done/);
    assert.match(output, /Task completed successfully/);
  } finally {
    surface.stop();
  }
});
