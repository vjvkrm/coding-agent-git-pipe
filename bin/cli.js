#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const entry = path.resolve(__dirname, "..", "dist", "cli.js");

if (!fs.existsSync(entry)) {
  console.error("Build output not found. Run `npm run build` first.");
  process.exit(1);
}

const cli = require(entry);

if (typeof cli.main !== "function") {
  console.error(`CLI entry at ${entry} does not export a main() function.`);
  process.exit(1);
}

Promise.resolve(cli.main(process.argv)).catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
