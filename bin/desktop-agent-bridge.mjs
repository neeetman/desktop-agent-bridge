#!/usr/bin/env node
import {main} from '../src/cli/bridge-cli.mjs';
await main(process.argv.slice(2));
