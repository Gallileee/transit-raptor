#!/usr/bin/env node
// The command-line entry point; everything testable lives in cli.ts.
import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2));
