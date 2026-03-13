import process from "node:process";
import type React from "react";

type EsmImportFn = <T>(specifier: string) => Promise<T>;

const importEsm = Function("specifier", "return import(specifier);") as EsmImportFn;

export interface InkKeyLike {
  ctrl?: boolean;
  [key: string]: unknown;
}

export interface InkTextInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  readonly focus?: boolean;
  readonly placeholder?: string;
  readonly showCursor?: boolean;
  readonly highlightPastedText?: boolean;
}

export interface InkStaticProps {
  readonly items: readonly unknown[];
  readonly children: (item: unknown, index: number) => React.ReactNode;
  readonly style?: Record<string, unknown>;
}

export interface InkRuntime {
  readonly render: (node: React.ReactNode, options?: Record<string, unknown>) => InkInstance;
  readonly Box: React.ComponentType<any>;
  readonly Text: React.ComponentType<any>;
  readonly Static: React.ComponentType<InkStaticProps>;
  readonly TextInput: React.ComponentType<InkTextInputProps>;
  readonly useInput: (
    handler: (input: string, key: InkKeyLike) => void,
    options?: { readonly isActive?: boolean }
  ) => void;
}

export interface InkInstance {
  readonly rerender: (node: React.ReactNode) => void;
  readonly unmount: () => void;
  readonly cleanup: () => void;
  readonly clear: () => void;
}

let cachedRuntimePromise: Promise<InkRuntime> | null = null;

export function shouldUseInkDebugMode(stdout: NodeJS.WriteStream): boolean {
  if (process.env.AGENT_PIPE_INK_DEBUG === "1") {
    return true;
  }

  return typeof (stdout as { fd?: unknown }).fd !== "number";
}

export async function loadInkRuntime(): Promise<InkRuntime> {
  if (cachedRuntimePromise) {
    return cachedRuntimePromise;
  }

  cachedRuntimePromise = (async () => {
    const inkModule = await importEsm<Record<string, unknown>>("ink");
    const textInputModule = await importEsm<Record<string, unknown>>("ink-text-input");

    return {
      render: (inkModule.default || inkModule.render) as InkRuntime["render"],
      Box: inkModule.Box as InkRuntime["Box"],
      Text: inkModule.Text as InkRuntime["Text"],
      Static: inkModule.Static as InkRuntime["Static"],
      TextInput: textInputModule.default as InkRuntime["TextInput"],
      useInput: inkModule.useInput as InkRuntime["useInput"],
    };
  })();

  return cachedRuntimePromise;
}
