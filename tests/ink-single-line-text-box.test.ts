import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import SingleLineTextBox from "../src/ink/SingleLineTextBox";
import { normalizeSingleLineInput } from "../src/ink/normalizeSingleLineInput";

function Box(props: Record<string, unknown>): React.JSX.Element {
  return React.createElement("box", props, props.children);
}

function Text(props: Record<string, unknown>): React.JSX.Element {
  return React.createElement("text", props, props.children);
}

function TextInput(props: Record<string, unknown>): React.JSX.Element {
  return React.createElement("text-input", props);
}

test("SingleLineTextBox keeps the prompt prefix and input on one row", () => {
  const tree = SingleLineTextBox({
    ui: {
      Box: Box as unknown as React.ComponentType<any>,
      Text: Text as unknown as React.ComponentType<any>,
      TextInput: TextInput as unknown as React.ComponentType<any>,
    },
    prefixText: "Reply > ",
    value: "",
    onChange: () => {},
    onSubmit: () => {},
  });

  assert.equal(tree.type, Box);
  assert.equal(tree.props.flexDirection, "row");

  const children = React.Children.toArray(tree.props.children) as React.ReactElement[];
  assert.equal(children.length, 2);
  assert.equal(children[0].type, Text);
  assert.equal(children[0].props.children, "Reply > ");
  assert.equal(children[1].type, Box);
  assert.equal(children[1].props.flexGrow, 1);

  const input = React.Children.only(children[1].props.children) as React.ReactElement;
  assert.equal(input.type, TextInput);
  assert.equal(input.props.showCursor, true);
  assert.equal(input.props.highlightPastedText, true);
});

test("SingleLineTextBox flattens pasted newlines before updating state", () => {
  let changedValue = "";

  const tree = SingleLineTextBox({
    ui: {
      Box: Box as unknown as React.ComponentType<any>,
      Text: Text as unknown as React.ComponentType<any>,
      TextInput: TextInput as unknown as React.ComponentType<any>,
    },
    prefixText: "> ",
    value: "",
    onChange: (nextValue) => {
      changedValue = nextValue;
    },
    onSubmit: () => {},
  });

  const children = React.Children.toArray(tree.props.children) as React.ReactElement[];
  const inputBox = children[1] as React.ReactElement;
  const input = React.Children.only(inputBox.props.children) as React.ReactElement;

  input.props.onChange("first line\nsecond line");
  assert.equal(changedValue, "first line second line");
});

test("normalizeSingleLineInput removes synthetic edge spaces from terminal newlines", () => {
  assert.equal(normalizeSingleLineInput("hello\n"), "hello");
  assert.equal(normalizeSingleLineInput("\nhello"), "hello");
  assert.equal(normalizeSingleLineInput("hello\nworld"), "hello world");
});
