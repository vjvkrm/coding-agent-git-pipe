import test from "node:test";
import assert from "node:assert/strict";
import { validateContract } from "../src/contract";

test("validateContract accepts valid contract", () => {
  const contract = validateContract({
    contract_version: "1",
    next_action: "review",
    to: "primary",
    message: "  review auth flow  ",
  });

  assert.equal(contract.contract_version, "1");
  assert.equal(contract.next_action, "review");
  assert.equal(contract.to, "primary");
  assert.equal(contract.message, "review auth flow");
});

test("validateContract rejects invalid target", () => {
  assert.throws(
    () =>
      validateContract({
        contract_version: "1",
        next_action: "review",
        to: "unknown-agent",
        message: "test",
      }),
    /to must be one of/
  );
});

// --- v2 field tests ---

test("validateContract accepts sentiment field", () => {
  const contract = validateContract({
    contract_version: "1",
    next_action: "done",
    message: "Looks good",
    sentiment: "agree",
  });
  assert.equal(contract.sentiment, "agree");
});

test("validateContract rejects invalid sentiment", () => {
  assert.throws(
    () =>
      validateContract({
        contract_version: "1",
        next_action: "done",
        message: "test",
        sentiment: "maybe",
      }),
    /sentiment must be one of/
  );
});

test("validateContract accepts concerns array", () => {
  const contract = validateContract({
    contract_version: "1",
    next_action: "done",
    message: "Has issues",
    sentiment: "partial",
    concerns: ["performance issue", "missing error handling"],
  });
  assert.deepEqual(contract.concerns, ["performance issue", "missing error handling"]);
});

test("validateContract rejects non-array concerns", () => {
  assert.throws(
    () =>
      validateContract({
        contract_version: "1",
        next_action: "done",
        message: "test",
        concerns: "not an array",
      }),
    /concerns must be an array/
  );
});

test("validateContract accepts proposal field", () => {
  const contract = validateContract({
    contract_version: "1",
    next_action: "done",
    message: "Proposed approach",
    proposal: {
      summary: "Add auth middleware",
      approach: "Create JWT validation layer",
      files: ["src/auth.ts", "src/middleware.ts"],
    },
  });
  assert.equal(contract.proposal?.summary, "Add auth middleware");
  assert.equal(contract.proposal?.approach, "Create JWT validation layer");
  assert.deepEqual(contract.proposal?.files, ["src/auth.ts", "src/middleware.ts"]);
});

test("validateContract rejects proposal with missing summary", () => {
  assert.throws(
    () =>
      validateContract({
        contract_version: "1",
        next_action: "done",
        message: "test",
        proposal: { approach: "do stuff" },
      }),
    /proposal.summary must be a non-empty string/
  );
});

test("validateContract accepts review_verdict field", () => {
  const contract = validateContract({
    contract_version: "1",
    next_action: "done",
    message: "Code looks good",
    review_verdict: "approve",
  });
  assert.equal(contract.review_verdict, "approve");
});

test("validateContract rejects invalid review_verdict", () => {
  assert.throws(
    () =>
      validateContract({
        contract_version: "1",
        next_action: "done",
        message: "test",
        review_verdict: "maybe-approve",
      }),
    /review_verdict must be one of/
  );
});

test("validateContract accepts review_comments with file and line", () => {
  const contract = validateContract({
    contract_version: "1",
    next_action: "primary",
    message: "Fix these issues",
    review_verdict: "request-changes",
    review_comments: [
      { file: "src/auth.ts", line: 42, comment: "Missing null check" },
      { comment: "Add more tests" },
    ],
  });
  assert.equal(contract.review_comments?.length, 2);
  assert.equal(contract.review_comments?.[0].file, "src/auth.ts");
  assert.equal(contract.review_comments?.[0].line, 42);
  assert.equal(contract.review_comments?.[1].file, undefined);
});

test("validateContract rejects review_comments with missing comment field", () => {
  assert.throws(
    () =>
      validateContract({
        contract_version: "1",
        next_action: "done",
        message: "test",
        review_comments: [{ file: "src/foo.ts" }],
      }),
    /review_comments\[0\].comment must be a non-empty string/
  );
});

test("validateContract accepts confidence field", () => {
  const contract = validateContract({
    contract_version: "1",
    next_action: "done",
    message: "test",
    confidence: 0.85,
  });
  assert.equal(contract.confidence, 0.85);
});

test("validateContract rejects confidence out of range", () => {
  assert.throws(
    () =>
      validateContract({
        contract_version: "1",
        next_action: "done",
        message: "test",
        confidence: 1.5,
      }),
    /confidence must be a number between 0 and 1/
  );
});

test("validateContract accepts full v2 contract with all optional fields", () => {
  const contract = validateContract({
    contract_version: "1",
    next_action: "review",
    message: "Implementation complete",
    sentiment: "neutral",
    concerns: [],
    proposal: {
      summary: "Added feature X",
      approach: "Used pattern Y",
    },
    review_verdict: "request-changes",
    review_comments: [{ file: "src/x.ts", line: 10, comment: "Typo" }],
    confidence: 0.95,
  });
  assert.equal(contract.sentiment, "neutral");
  assert.equal(contract.review_verdict, "request-changes");
  assert.equal(contract.confidence, 0.95);
});
