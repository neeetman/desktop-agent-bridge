import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import manifest from "../../package.json" with { type: "json" };

if (process.platform !== "win32") throw Error("Windows Electron is required");

const root = fileURLToPath(new URL("../..", import.meta.url));
const output = path.resolve(process.argv[2] ?? path.join(
  root, "runtime", "windows", `desktop-agent-bridge-${manifest.version}-win32-${process.arch}`,
));
const parent = path.dirname(output);
await mkdir(parent, { recursive: true });
const staging = await mkdtemp(path.join(parent, ".bridge-console-"));
if (path.dirname(staging) !== parent || !path.basename(staging).startsWith(".bridge-console-")) {
  throw Error("Unexpected staging path");
}
const executable = "Desktop Agent Bridge.exe";
try {
  await cp(path.dirname(electron), staging, { recursive: true });
  await rename(path.join(staging, "electron.exe"), path.join(staging, executable));
  const app = path.join(staging, "resources", "app");
  await cp(path.join(root, "src", "console"), app, { recursive: true });
  await writeFile(path.join(app, "package.json"), JSON.stringify({
    name: "desktop-agent-bridge-console",
    productName: "Desktop Agent Bridge",
    version: manifest.version,
    main: "main.cjs",
    bridgeRoot: path.resolve(root),
  }, null, 2) + "\n");
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(staging, output);
      break;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100 * 2 ** (attempt - 1), 1000)));
    }
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
console.log(path.join(output, executable));
