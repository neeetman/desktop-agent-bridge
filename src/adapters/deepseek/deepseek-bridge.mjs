import {projectURL} from "../../lib/paths.mjs";
import { fileURLToPath } from 'node:url';
import { DeepSeekTools } from './deepseek-native.mjs';
import { startBridge } from '../../core/bridge.mjs';
const tools = new DeepSeekTools();
await tools.call('list_threads', { limit: 1 });
const bridge = await startBridge({ tools, stateDir: fileURLToPath(projectURL("runtime/deepseek/")), port: 43133, pollMs: 2000, enableIpc: false });
console.log('DeepSeek desktop bridge ready on 127.0.0.1:43133');
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => void bridge.close().then(() => process.exit(0)));
