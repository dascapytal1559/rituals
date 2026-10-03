// Existing Node + Playwright + installed Chrome; no dependency installation.
const fs=require('node:fs'),path=require('node:path');
const assert=require('node:assert/strict'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const {playwright,CHROME}=require('./playwright.cjs');
const fixture=JSON.parse(cp.execFileSync('/usr/bin/python3',['-c',`
import datetime as dt,json
from pathlib import Path
import dashboard,dashboard_web
r=[{'date':'2026-10-03','checkins':['2026-10-03T12:12:00Z'],'magnesium':None,'protein':True,'stretching':True,'journalling':None,'plank_seconds':80}]
w=[{'id':'fictional','date':'2026-10-03','type':'gym push'}]
s=dt.datetime.fromisoformat('2026-10-04T13:00:00+11:00')
from unittest.mock import patch
with patch('dashboard.read_records',return_value=(r,w,[])):
 data=dashboard_web.dashboard_data(Path('/unused'),s)
print(json.dumps({'data':data,'live':dashboard_web.frontend().decode(),'static':dashboard.render(dashboard.matrix(r,w),s,Path('/unused'),dashboard.status_report(r,w,[],s))}))
`],{env:{...process.env,PYTHONPATH:path.join(root,'app'),PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8'}));
(async()=>{
 const {chromium}=playwright();
 const browser=await chromium.launch({headless:true,executablePath:CHROME,chromiumSandbox:true});
 const cases=[];
 try{
  for(const width of [390,1280])for(const colorScheme of ['light','dark'])for(const kind of ['static','live']){
   const context=await browser.newContext({viewport:{width,height:844},isMobile:width===390,hasTouch:width===390,colorScheme});
   let uiVersion='A';
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await context.route('**/*',route=>{
    const u=route.request().url();
    if(u==='https://ritual.test/')return route.fulfill({contentType:'text/html',body:fixture[kind].replace(/<h1[^>]*>.*?<\/h1>/,'<h1>Fictional UI handover '+uiVersion+'</h1>')});
    if(kind==='live'&&u==='https://ritual.test/api/dashboard')return route.fulfill({contentType:'application/json',body:JSON.stringify(fixture.data)});
    return route.abort();
   });
   await page.goto('https://ritual.test/');await page.waitForSelector('tbody tr');
   assert.equal(await page.locator('.checkin').innerText(),'22:12');
   assert.equal(await page.locator('.checkin time').count(),1);
   assert.equal(await page.locator('h1').isVisible(),true);
   if(width===390){
    // Title bar holds the theme button; the table fills the rest and ends flush with the screen.
    const bar=await page.locator('header').boundingBox();assert.equal(bar.x,0);assert.equal(bar.y,0);assert.equal(bar.width,width);
    const box=await page.locator('#theme-toggle').boundingBox();assert.equal(box.width,44);assert.equal(box.height,44);
    assert.ok(box.y>=bar.y&&box.y+box.height<=bar.y+bar.height,'theme button inside title bar');
    assert.equal(await page.locator('#theme-toggle').evaluate(e=>getComputedStyle(e).position),'static');
    assert.deepEqual(await page.locator('.sheet').boundingBox(),{x:0,y:bar.y+bar.height,width,height:844-bar.y-bar.height});
    const bottom=await page.evaluate(()=>{
     const body=document.querySelector('tbody'),scroll=document.querySelector('.scroll');
     for(let i=0;i<40;i++)body.append(body.rows[0].cloneNode(true));
     scroll.scrollTop=scroll.scrollHeight;
     return {row:body.rows[body.rows.length-1].getBoundingClientRect().bottom,head:document.querySelector('thead th').getBoundingClientRect().top};
    });
    assert.equal(bottom.row,844,'last row flush with screen bottom');assert.equal(bottom.head,bar.y+bar.height,'sticky header beneath title bar');
    // Browser tabs: title bar top padding is 4px plus the reported inset, nothing more.
    const padTop=()=>page.locator('header').evaluate(e=>parseFloat(getComputedStyle(e).paddingTop));
    const top=()=>page.evaluate(()=>({button:document.querySelector('#theme-toggle').getBoundingClientRect().top,title:document.querySelector('h1').getBoundingClientRect().top,bar:document.querySelector('header').getBoundingClientRect().bottom,head:document.querySelector('thead th').getBoundingClientRect().top}));
    assert.equal(await padTop(),4,'no extra top gap in a tab without an inset');assert.equal(box.y,4);
    const cdp=await context.newCDPSession(page);
    const insets=top=>cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top,bottom:top?34:0}});
    await insets(59);assert.equal(await padTop(),63,'tab with an inset: inset only, no extra gap');
    // Home-screen web app: 10px extra below the inset, which iOS 26 reports as 0 there. Chrome ignores display-mode
    // emulation, so check the rule is gated on standalone/fullscreen and unmatched here, then force it on via CSSOM.
    const webAppRule=force=>page.evaluate(force=>{
     const rule=[...document.styleSheets].flatMap(s=>[...s.cssRules]).find(r=>r.media&&/display-mode/.test(r.media.mediaText));
     const text=rule.media.mediaText,matched=matchMedia(text).matches;
     if(force)rule.media.mediaText='all';
     return {text,matched};
    },force);
    assert.deepEqual(await webAppRule(false),{text:'(display-mode: standalone), (display-mode: fullscreen)',matched:false},'web app rule gated on display-mode and unmatched in a tab');
    await webAppRule(true);await insets(0);
    assert.equal(await padTop(),14,'web app: 10px extra with a 0 inset');
    let t=await top();assert.ok(t.button>=14&&t.title>=14,'web app: button and title start below the 10px gap');assert.equal(t.head,t.bar);
    await insets(59);
    assert.equal(await padTop(),73,'web app: a reported inset adds to the 10px once, no double gap');
    t=await top();assert.ok(t.button>=69&&t.title>=69,'web app: below the inset plus 10px gap');assert.equal(t.head,t.bar,'sticky header beneath title bar in web app');
    await insets(0);
    // Without a manifest WebKit reports display-mode browser, so an iOS web clip is also detected by navigator.standalone.
    const clip=await context.newPage();clip.on('pageerror',e=>errors.push(e.message));
    await clip.addInitScript(()=>Object.defineProperty(Navigator.prototype,'standalone',{configurable:true,get:()=>true}));
    await clip.goto('https://ritual.test/');await clip.waitForSelector('tbody tr');
    assert.equal(await clip.evaluate(()=>document.documentElement.dataset.webApp),'ios');
    assert.equal(await clip.locator('header').evaluate(e=>parseFloat(getComputedStyle(e).paddingTop)),14,'navigator.standalone: 10px extra');
    await clip.close();
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.webApp),undefined,'tabs are not flagged as a web app');
   }else{
    // Desktop keeps its layout even when flagged as a web app.
    const pad=()=>page.locator('header').evaluate(e=>getComputedStyle(e).paddingTop);
    const before=await pad();await page.evaluate(()=>document.documentElement.dataset.webApp='ios');
    assert.equal(await pad(),before,'desktop header unchanged in a web app');
    await page.evaluate(()=>delete document.documentElement.dataset.webApp);
   }
   assert.equal(await page.locator('h1').textContent(),'Fictional UI handover A');
   await page.locator('#theme-toggle').click();
   uiVersion='B';
   await page.reload();await page.waitForSelector('tbody tr');
   assert.equal(await page.locator('h1').textContent(),'Fictional UI handover B');
   assert.deepEqual(errors,[]);cases.push({kind,width,colorScheme,fixture_edit_reload:true,passed:true});await context.close();
  }
  if(process.argv.includes('--live')){
   const hostname=JSON.parse(fs.readFileSync(path.join(root,'config/dashboard-server.json'))).tailscale_hostname;
   const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   const url='https://'+hostname+'/';const response=await page.goto(url);assert.equal(response.status(),200);
   await page.waitForSelector('tbody tr');
   const api=await context.request.get(url+'api/dashboard');assert.equal(api.status(),200);
   const data=await api.json();assert.equal(await page.locator('tbody tr').count(),data.rows.length);
   await page.reload();await page.waitForSelector('tbody tr');assert.deepEqual(errors,[]);
   cases.push({kind:'actual-private-https',rows:data.rows.length,passed:true});await context.close();
  }
 }finally{await browser.close()}
 console.log(JSON.stringify({cases},null,2));
})().catch(e=>{console.error(e.message);process.exit(1)});
