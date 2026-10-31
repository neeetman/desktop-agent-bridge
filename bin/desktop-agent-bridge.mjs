#!/usr/bin/env node
import {main} from '../bridge-cli.mjs';
await main(process.argv.slice(2));
