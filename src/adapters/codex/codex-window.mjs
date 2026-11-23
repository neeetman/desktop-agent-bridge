// Codex answers its desktop chat tools (list, read, send, create) only while its window
// exists. Running from the tray alone, it accepts a tools/call and never completes it, so
// callers would wait out a 45-second timeout with an unknown outcome. These helpers check
// the window before a call and, for sends, reopen it first.
import fs from 'node:fs';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {sourcePath} from '../../lib/paths.mjs';
import {ROOT,compatError} from '../../compat/compatibility.mjs';

const run=promisify(execFile);
const python=()=>{try{return JSON.parse(fs.readFileSync(sourcePath(ROOT,'runtime/supervisor/config.json'),'utf8')).python||'python';}catch{return 'python';}};

export async function windowVisible(pid){
 const {stdout}=await run(python(),[sourcePath(ROOT,'desktop_inventory.py'),'--visible-window',String(pid)],{windowsHide:true,timeout:5000});
 return JSON.parse(stdout).visible===true;
}

// The MSIX package family from an install path such as
// ...\WindowsApps\OpenAI.Codex_26.1117.4957.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe
export function packageFamily(executable){
 const match=/[\\/]WindowsApps[\\/]([^_\\/]+)_[^_\\/]+_[^_\\/]+_[^_\\/]*_([a-z0-9]+)[\\/]/i.exec(String(executable??''));
 return match?match[1]+'_'+match[2]:null;
}

// Activating the packaged app shows the running instance's window (Electron second instance).
export function openWindow(executable){
 const family=packageFamily(executable);
 if(!family)throw compatError('CODEX_WINDOW_CLOSED','Codex window is closed and its package could not be identified; open Codex and retry');
 const child=spawn('explorer.exe',['shell:AppsFolder\\'+family+'!App'],{windowsHide:true,detached:true,stdio:'ignore'});
 child.on('error',()=>{});child.unref();
}

export const CLOSED_MESSAGE='Codex is running without its window (tray only); it answers chat tools only while the window is open. Open the Codex window and retry. Nothing was sent.';

// Ensures the window is open before a native tool call. Reads fail fast; sends reopen it.
export async function ensureWindow(runningBuild,{reopen=false,visible=windowVisible,open=openWindow,sleep=ms=>new Promise(r=>setTimeout(r,ms)),waitMs=15000}={}){
 const pid=runningBuild?.pid;
 if(!pid||process.platform!=='win32')return {checked:false};
 let shown;try{shown=await visible(pid);}catch{return {checked:false};}
 if(shown)return {checked:true,visible:true};
 if(!reopen)throw compatError('CODEX_WINDOW_CLOSED',CLOSED_MESSAGE);
 open(runningBuild.executable);
 for(let waited=0;waited<waitMs;waited+=250){await sleep(250);try{if(await visible(pid))return {checked:true,visible:true,reopened:true};}catch{}}
 throw compatError('CODEX_WINDOW_CLOSED','Codex window could not be reopened; open Codex and retry. Nothing was sent.');
}
