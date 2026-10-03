// Finds an existing Playwright; nothing is installed. Shared by the UI check and the screenshot command.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
exports.CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
exports.playwright=function(){
 if(process.env.RITUAL_PLAYWRIGHT_MODULE) return require(process.env.RITUAL_PLAYWRIGHT_MODULE);
 try{return require('playwright')}catch{}
 const cache=path.join(os.homedir(),'.npm','_npx');
 for(const dir of fs.existsSync(cache)?fs.readdirSync(cache).sort():[]){
  const module=path.join(cache,dir,'node_modules','playwright');
  if(fs.existsSync(path.join(module,'package.json'))) return require(module);
 }
 throw new Error('Existing Playwright missing. Set RITUAL_PLAYWRIGHT_MODULE to an existing module; no install was attempted.');
};
