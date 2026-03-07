import { Contract, NextAction } from "./types";

const NEXT_ACTIONS = new Set<NextAction>(["plan", "implement", "review", "pair", "ask-human", "done"]);

function validateQuestion(question: unknown, index: number): void {
  if (question === null || typeof question !== "object" || Array.isArray(question)) {
    throw new Error(`questions[${index}] must be an object`);
  }

  const value = question as { id?: unknown; text?: unknown };
  if (typeof value.id !== "string" || value.id.trim() === "") {
    throw new Error(`questions[${index}].id must be a non-empty string`);
  }

  if (typeof value.text !== "string" || value.text.trim() === "") {
    throw new Error(`questions[${index}].text must be a non-empty string`);
  }
}

export function validateContract(value: unknown): Contract {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Contract must be a JSON object");
  }

  const contract = value as {
    contract_version?: unknown;
    next_action?: unknown;
    to?: unknown;
    message?: unknown;
    questions?: unknown;
  };

  if (contract.contract_version !== "1") {
    throw new Error('contract_version must be the string "1"');
  }

  if (typeof contract.next_action !== "string" || !NEXT_ACTIONS.has(contract.next_action as NextAction)) {
    throw new Error("next_action must be one of: plan, implement, review, pair, ask-human, done");
  }

  if (contract.to !== undefined) {
    if (typeof contract.to !== "string" || !NEXT_ACTIONS.has(contract.to as NextAction)) {
      throw new Error("to must be one of: plan, implement, review, pair, ask-human, done");
    }
  }

  if (typeof contract.message !== "string" || contract.message.trim() === "") {
    throw new Error("message must be a non-empty string");
  }

  if (contract.questions !== undefined) {
    if (!Array.isArray(contract.questions)) {
      throw new Error("questions must be an array when provided");
    }

    for (let i = 0; i < contract.questions.length; i += 1) {
      validateQuestion(contract.questions[i], i);
    }

    if (contract.next_action === "ask-human" && contract.questions.length === 0) {
      throw new Error("questions cannot be an empty array when next_action=ask-human");
    }
  }

  return {
    contract_version: "1",
    next_action: contract.next_action as NextAction,
    to: contract.to as NextAction | undefined,
    message: contract.message.trim(),
    questions: contract.questions as Contract["questions"],
  };
}
