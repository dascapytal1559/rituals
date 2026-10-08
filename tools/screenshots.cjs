// Regenerates every README screenshot from a read-only copy of the store.
// Same harness as tests/check_ui.cjs: existing Node + Playwright + installed Chrome,
// pages served from memory at a fake origin, every other request aborted.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const {playwright,CHROME}=require('../tests/playwright.cjs');
// Defaults suit an adopter's single folder. From a separate working copy, point --db at the live database.
const options={'--db':path.join(root,'data','ritual.sqlite3'),'--out':path.join(root,'docs','screenshots')};
const args=process.argv.slice(2);
for(let i=0;i<args.length;i+=2){
 if(!(args[i] in options)||!args[i+1]){console.error('Usage: ritual-screenshots [--db PATH] [--out DIR]');process.exit(2)}
 options[args[i]]=path.resolve(args[i+1]);
}
const db=options['--db'],out=options['--out'];
// One shot list: change it here, and only here, when the README needs a new picture.
const SHOTS=[
 {name:'desktop-light',width:1440,height:900,scale:2,mobile:false,colorScheme:'light'},
 {name:'desktop-dark', width:1440,height:900,scale:2,mobile:false,colorScheme:'dark'},
 {name:'mobile-light', width:390, height:844,scale:3,mobile:true, colorScheme:'light'},
 {name:'mobile-dark',  width:390, height:844,scale:3,mobile:true, colorScheme:'dark'},
];
if(!fs.statSync(db,{throwIfNoEntry:false})?.isFile()){console.error('No database at '+db+'; pass --db PATH');process.exit(2)}
// tools/screenshot-page.ts snapshots the store with SQLite's backup API (source opened mode=ro),
// then renders the exact live payload and frontend from that private copy. The source is never written.
const page=JSON.parse(cp.execFileSync(process.execPath,[path.join(root,'tools','screenshot-page.ts'),db],{encoding:'utf8',maxBuffer:64<<20}));
(async()=>{
 const {chromium}=playwright();
 const browser=await chromium.launch({headless:true,executablePath:CHROME,chromiumSandbox:true});
 fs.mkdirSync(out,{recursive:true});
 try{
  for(const shot of SHOTS){
   const context=await browser.newContext({viewport:{width:shot.width,height:shot.height},deviceScaleFactor:shot.scale,
    isMobile:shot.mobile,hasTouch:shot.mobile,colorScheme:shot.colorScheme});
   await context.route('**/*',route=>{
    const u=route.request().url();
    if(u==='https://ritual.test/')return route.fulfill({contentType:'text/html',body:page.html});
    if(u==='https://ritual.test/api/dashboard')return route.fulfill({contentType:'application/json',body:JSON.stringify(page.api)});
    return route.abort();
   });
   const tab=await context.newPage(),errors=[];tab.on('pageerror',e=>errors.push(e.message));
   await tab.goto('https://ritual.test/');await tab.waitForSelector('tbody tr');
   await tab.waitForFunction(()=>!document.getElementById('updated').textContent.includes('—'));
   if(errors.length) throw new Error(shot.name+': '+errors.join('; '));
   const file=path.join(out,shot.name+'.png');
   await tab.screenshot({path:file});
   console.log(path.relative(process.cwd(),file));
   await context.close();
  }
 }finally{await browser.close()}
})().catch(e=>{console.error(e.message);process.exit(1)});
