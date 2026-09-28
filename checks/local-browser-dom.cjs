// Compatibility entry point for the expanded DOM regression suite.
const {spawnSync}=require('node:child_process');
const result=spawnSync(process.execPath,['--test',require('node:path').join(__dirname,'local-agent.test.cjs')],{stdio:'inherit'});
process.exitCode=result.status??1;
