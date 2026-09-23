#!/usr/bin/env node

import { runCli } from "./app.js";

process.exitCode = runCli(process.argv.slice(2));
