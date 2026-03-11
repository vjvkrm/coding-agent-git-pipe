import { Contract, NextAction, Proposal, ReviewComment, ReviewVerdict, Sentiment } from "./types";

const NEXT_ACTIONS = new Set<NextAction>(["primary", "review", "pair", "ask-human", "done"]);
const SENTIMENTS = new Set<Sentiment>(["agree", "disagree", "partial", "neutral"]);
const REVIEW_VERDICTS = new Set<ReviewVerdict>(["approve", "request-changes", "reject"]);

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

function validateProposal(proposal: unknown): Proposal {
  if (proposal === null || typeof proposal !== "object" || Array.isArray(proposal)) {
    throw new Error("proposal must be an object");
  }

  const value = proposal as { summary?: unknown; approach?: unknown; files?: unknown };
  if (typeof value.summary !== "string" || value.summary.trim() === "") {
    throw new Error("proposal.summary must be a non-empty string");
  }

  if (typeof value.approach !== "string" || value.approach.trim() === "") {
    throw new Error("proposal.approach must be a non-empty string");
  }

  const result: Proposal = {
    summary: value.summary.trim(),
    approach: value.approach.trim(),
  };

  if (value.files !== undefined) {
    if (!Array.isArray(value.files)) {
      throw new Error("proposal.files must be an array when provided");
    }

    for (let i = 0; i < value.files.length; i += 1) {
      if (typeof value.files[i] !== "string" || (value.files[i] as string).trim() === "") {
        throw new Error(`proposal.files[${i}] must be a non-empty string`);
      }
    }
    result.files = value.files as string[];
  }

  return result;
}

function validateReviewComment(comment: unknown, index: number): ReviewComment {
  if (comment === null || typeof comment !== "object" || Array.isArray(comment)) {
    throw new Error(`review_comments[${index}] must be an object`);
  }

  const value = comment as { file?: unknown; line?: unknown; comment?: unknown };
  if (typeof value.comment !== "string" || value.comment.trim() === "") {
    throw new Error(`review_comments[${index}].comment must be a non-empty string`);
  }

  const result: ReviewComment = { comment: value.comment.trim() };

  if (value.file !== undefined) {
    if (typeof value.file !== "string" || value.file.trim() === "") {
      throw new Error(`review_comments[${index}].file must be a non-empty string when provided`);
    }
    result.file = value.file.trim();
  }

  if (value.line !== undefined) {
    if (typeof value.line !== "number" || !Number.isInteger(value.line) || value.line < 0) {
      throw new Error(`review_comments[${index}].line must be a non-negative integer when provided`);
    }
    result.line = value.line;
  }

  return result;
}

export function validateContract(value: unknown): Contract {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Contract must be a JSON object");
  }

  const contract = value as Record<string, unknown>;

  if (contract.contract_version !== "1") {
    throw new Error('contract_version must be the string "1"');
  }

  if (typeof contract.next_action !== "string" || !NEXT_ACTIONS.has(contract.next_action as NextAction)) {
    throw new Error("next_action must be one of: primary, review, pair, ask-human, done");
  }

  if (contract.to !== undefined) {
    if (typeof contract.to !== "string" || !NEXT_ACTIONS.has(contract.to as NextAction)) {
      throw new Error("to must be one of: primary, review, pair, ask-human, done");
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

  const result: Contract = {
    contract_version: "1",
    next_action: contract.next_action as NextAction,
    to: contract.to as NextAction | undefined,
    message: (contract.message as string).trim(),
    questions: contract.questions as Contract["questions"],
  };

  // --- v2 optional fields ---

  if (contract.sentiment !== undefined) {
    if (typeof contract.sentiment !== "string" || !SENTIMENTS.has(contract.sentiment as Sentiment)) {
      throw new Error("sentiment must be one of: agree, disagree, partial, neutral");
    }
    result.sentiment = contract.sentiment as Sentiment;
  }

  if (contract.concerns !== undefined) {
    if (!Array.isArray(contract.concerns)) {
      throw new Error("concerns must be an array when provided");
    }
    for (let i = 0; i < contract.concerns.length; i += 1) {
      if (typeof contract.concerns[i] !== "string") {
        throw new Error(`concerns[${i}] must be a string`);
      }
    }
    result.concerns = contract.concerns as string[];
  }

  if (contract.proposal !== undefined) {
    result.proposal = validateProposal(contract.proposal);
  }

  if (contract.review_verdict !== undefined) {
    if (
      typeof contract.review_verdict !== "string" ||
      !REVIEW_VERDICTS.has(contract.review_verdict as ReviewVerdict)
    ) {
      throw new Error("review_verdict must be one of: approve, request-changes, reject");
    }
    result.review_verdict = contract.review_verdict as ReviewVerdict;
  }

  if (contract.review_comments !== undefined) {
    if (!Array.isArray(contract.review_comments)) {
      throw new Error("review_comments must be an array when provided");
    }
    result.review_comments = [];
    for (let i = 0; i < contract.review_comments.length; i += 1) {
      result.review_comments.push(validateReviewComment(contract.review_comments[i], i));
    }
  }

  if (contract.confidence !== undefined) {
    if (typeof contract.confidence !== "number" || contract.confidence < 0 || contract.confidence > 1) {
      throw new Error("confidence must be a number between 0 and 1");
    }
    result.confidence = contract.confidence;
  }

  return result;
}
