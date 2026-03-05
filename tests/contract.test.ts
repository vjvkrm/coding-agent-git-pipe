import test from "node:test";
import assert from "node:assert/strict";
import { validateContract } from "../src/contract";

test("validateContract accepts valid contract", () => {
  const contract = validateContract({
    contract_version: "1",
    next_action: "review",
    to: "plan",
    message: "  review auth flow  ",
  });

  assert.equal(contract.contract_version, "1");
  assert.equal(contract.next_action, "review");
  assert.equal(contract.to, "plan");
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
