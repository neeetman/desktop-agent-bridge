import {projectURL} from "../lib/paths.mjs";
import fs from 'node:fs';
const connection=JSON.parse(fs.readFileSync(projectURL("runtime/supervisor/connection.json")));
const route=process.argv[2]==='pause'?'/pause':process.argv[2]==='resume'?'/resume':'/status';
const response=await fetch(connection.baseUrl+route,{method:route==='/status'?'GET':'POST',headers:{Authorization:`Bearer ${connection.token}`},signal:AbortSignal.timeout(5000)});
console.log(JSON.stringify(await response.json(),null,2));
