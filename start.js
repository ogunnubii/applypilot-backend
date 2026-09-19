import {spawn} from 'node:child_process';
import './server.js';
let stopping=false,child=null;
function launch(){if(stopping)return;child=spawn(process.execPath,['worker.js'],{cwd:import.meta.dirname,stdio:'inherit',env:process.env});child.on('exit',(code)=>{if(stopping)return;console.error(`Worker exited (${code}); restarting shortly`);setTimeout(launch,3000)})}
launch();process.on('SIGTERM',()=>{stopping=true;child?.kill('SIGTERM');setTimeout(()=>process.exit(0),1000)});
