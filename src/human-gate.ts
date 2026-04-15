import readline from "readline";
import { HumanInputPayload } from "./types";

function askLine(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(promptText, (answer) => {
      rl.close();
      // Collapse pasted newlines into spaces
      resolve(answer.replace(/[\r\n]+/g, " ").trim());
    });
  });
}

export async function askHumanInput(payload: HumanInputPayload): Promise<string> {
  const heading = payload.heading || "=== human gate ===";
  const message = payload.message || "Agent requested human input.";
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const footer = typeof payload.footer === "string" ? payload.footer : "";
  const promptText = payload.promptText || "human> ";
  const showMessage = payload.showMessage !== false;

  console.log(`\n${heading}`);

  if (showMessage) {
    console.log(message);
  }

  if (questions.length > 0) {
    console.log("");
    for (const question of questions) {
      console.log(`- [${question.id}] ${question.text}`);
    }
  }

  if (footer !== "") {
    console.log("");
    console.log(footer);
  }

  console.log("");
  return askLine(promptText);
}
