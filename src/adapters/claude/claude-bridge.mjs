import {projectURL} from "../../lib/paths.mjs";
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeTools } from './claude-native.mjs';
import { startBridge } from '../../core/bridge.mjs';

const tools = new ClaudeTools();
await tools.call('list_threads', { limit: 1 });
const bridge = await startBridge({ tools, stateDir: fileURLToPath(projectURL("runtime/claude")), port: 43129, pollMs: 3000, enableIpc: false });
console.log(`Claude desktop bridge ready at ${bridge.baseUrl}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => bridge.close().then(() => process.exit(0)));
