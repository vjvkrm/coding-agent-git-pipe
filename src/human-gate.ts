import readline from "readline";
import { Question } from "./types";

function askLine(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function askHumanInput(payload: { message?: string; questions?: Question[] }): Promise<string> {
  const message = payload.message || "Agent requested human input.";
  const questions = Array.isArray(payload.questions) ? payload.questions : [];

  console.log("\n=== human gate ===");
  console.log(message);

  if (questions.length > 0) {
    console.log("");
    for (const question of questions) {
      console.log(`- [${question.id}] ${question.text}`);
    }
  }

  console.log("");
  return askLine("human> ");
}
