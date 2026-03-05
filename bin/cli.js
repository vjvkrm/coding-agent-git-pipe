#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const entry = path.resolve(__dirname, "..", "dist", "cli.js");

if (!fs.existsSync(entry)) {
  console.error("Build output not found. Run `npm run build` first.");
  process.exit(1);
}

require(entry);
