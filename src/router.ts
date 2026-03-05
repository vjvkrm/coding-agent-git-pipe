import { Config, Contract, NextAction, TargetName } from "./types";

export function resolveTarget(contract: Contract, config: Config): TargetName {
  const action: NextAction = contract.to || contract.next_action;

  if (action === "done") {
    return "stop";
  }

  if (action === "ask-human") {
    return "human";
  }

  const mapped = config.routing[action];
  if (!mapped) {
    throw new Error(`No routing target configured for action=${action}`);
  }

  return mapped;
}
