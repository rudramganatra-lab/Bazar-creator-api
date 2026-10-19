/* Bazar Creator API: accounts, pages, posts, likes, follows. Cloudflare Worker + D1.
   Var: ALLOWED_ORIGIN (your site origin; comma-separate several). */
const enc=new TextEncoder(),hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const sha=async s=>hex(await crypto.subtle.digest('SHA-256',enc.encode(s)));
const rnd=n=>hex(crypto.getRandomValues(new Uint8Array(n)));
const hash=async(pw,salt)=>{const k=await crypto.subtle.importKey('raw',enc.encode(pw),'PBKDF2',false,['deriveBits']);return hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:enc.encode(salt),iterations:100000},k,256))};
const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
const ok=async(rl,key)=>rl?(await rl.limit({key})).success:true;
const pub=u=>({handle:u.handle,name:u.name,bio:u.bio,mode:u.mode});
const isAdmin=(env,u)=>(env.ADMINS||'').split(',').map(x=>x.trim().toLowerCase()).includes(u.handle);
const KINDS=['post','reel','video'];
const COND={feed:'1=1',posts:"p.uid=?2 AND p.kind IN ('post','video')",reels:"p.uid=?2 AND p.kind='reel'",remix:'p.uid=?2 AND p.remix IS NOT NULL',collab:'p.collab IS NOT NULL AND (p.uid=?2 OR p.collab=?2)',tagged:'EXISTS(SELECT 1 FROM tags t WHERE t.post=p.id AND t.uid=?2)'};
const BASE='You are Bazar, the creator coach inside StockBazar, a game that teaches how the stock market and businesses work with virtual money. Be practical, friendly and concise, under 250 words. Never predict prices or tell anyone to buy or sell real securities. Keep everything original, honest and suitable for ages 13 and up. ';
const SK=[
['Hook writer','Write 5 scroll-stopping first lines for the idea below. Each under 12 words, in different styles.'],
['Caption writer','Write 3 captions for the post idea below: one short, one story-style, one that asks a question. End each with a call to action.'],
['Hashtag finder','Suggest 15 relevant hashtags for the topic below, from broad to niche, on one line.'],
['Reel script','Write a 30-second reel script for the idea below: a hook, 3 beats and a call to action. Mark the on-screen text.'],
['Long-video outline','Create a long video outline for the topic below: title, hook, 5 chapters with timestamps, and an ending.'],
['Title and thumbnail','Give 5 video titles and 3 thumbnail ideas for the topic below. Keep titles honest, not clickbait.'],
['Content calendar','Plan a 7-day content calendar for the page or niche below, mixing posts, reels and one long video.'],
['Niche finder','From the interests below, suggest 3 niches, who each one serves, and one first content idea for each.'],
['Bio and page name','Write 3 page names and 3 bios under 160 characters for the page described below.'],
['Comment replies','Draft 3 friendly replies to the comment below: one funny, one helpful, one that asks a question back.'],
['Business pitch','Turn the business idea below into a 5-sentence pitch: problem, solution, customer, how it earns, and the ask.'],
['Collab message','Write a short, polite message inviting another creator to collaborate on the idea below.'],
['Doubt solver','Explain the question below simply, with an everyday example, for a beginner. If it is about markets, teach the idea only and give no investment advice.']];
/* Sign-in is StockBazar's own login. The app sends the StockBazar token; we confirm it once with the main server
   (var MAIN_API) and remember it for 10 minutes. No second account or password exists here. */
const who=async(req,env)=>{
 const t=(req.headers.get('authorization')||'').slice(7);if(t.length<20||t.length>300)return null;
 const D=env.DB,th=await sha(t),now=Date.now(),Q='SELECT u.id,u.handle,u.name,u.bio,u.mode FROM sessions s JOIN users u ON u.id=s.uid WHERE s.th=?1 AND s.exp>?2 AND NOT EXISTS(SELECT 1 FROM banned x WHERE x.uid=u.id)';
 const hit=await D.prepare(Q).bind(th,now).first();if(hit)return hit;
 if(!await ok(env.AUTH_RL,'t:'+(req.headers.get('cf-connecting-ip')||'x')))return null;
 const base=String(env.MAIN_API||'').replace(/\/+$/,'');if(!base)return null;
 let j;try{const x=await fetch(base+'/api/auth/me',{headers:{authorization:'Bearer '+t}});if(!x.ok)return null;j=await x.json()}catch(e){return null}
 const hd=String(j&&j.username||'').toLowerCase();if(!/^[a-z0-9_]{3,20}$/.test(hd))return null;
 const nm=String(j.display||hd).replace(/[<>]/g,'').slice(0,40)||hd;
 await D.prepare("INSERT OR IGNORE INTO users(handle,pw,name,mode,created) VALUES(?1,'!',?2,'creator',?3)").bind(hd,nm,now).run();
 const u=await D.prepare('SELECT id,handle,name,bio,mode FROM users WHERE handle=?1').bind(hd).first();if(!u)return null;
 if(await D.prepare('SELECT 1 FROM banned WHERE uid=?1').bind(u.id).first())return null;
 await D.prepare('INSERT OR REPLACE INTO sessions(th,uid,exp) VALUES(?1,?2,?3)').bind(th,u.id,now+6e5).run();
 return u};

/* ---------- business rules: the server runs every action, the app only shows the result ---------- */
class GameErr extends Error{}
const need=(c,m)=>{if(!c)throw new GameErr(m)};
const FV=10,LIC=25e3,PLOT=2e5,PAY=1800,GB=1e5,MAXL=5e5;
const SEC={'Café':{r:3000,lic:['FSSAI food licence','Shop & Establishment']},'Tech startup':{r:3800,lic:['GST registration','Startup India (DPIIT)']},'Clothing brand':{r:3200,lic:['GST registration','Trade licence']},'Learning app':{r:3400,lic:['GST registration','Company incorporation (MCA)']}};
const EV=[['Festival rush: sales +30%',1.3],['Supplier delay: sales −20%',.8],['A reel goes viral: sales +45%',1.45],['Rain keeps people home: sales −10%',.9],['Quiet day',1],['Quiet day',1]];
const PT=[{s:'Sales lead',inv:2e5,sh:.2},{s:'Tech lead',inv:2e5,sh:.2},{s:'Finance lead',inv:3e5,sh:.25}];
const MK=[[1e4,3,1.05],[4e4,7,1.2],[1e5,14,1.35]];
const NPC=[['Kaveri Foods',48],['Orbit Tech',212],['Meher Textiles',96]],NEWIPO=['Sagar Pharma','Neon Mobility','Dhara Energy','Lotus Retail'];
const cap=c=>3+5*c.land,work=c=>1+c.staff,hasP=(c,r)=>c.pt.some(i=>PT[i].s.startsWith(r));
const hold=(c,ex)=>Object.entries(c.hd).reduce((a,[n,h])=>a+h.q*(ex.find(x=>x.n===n)?.p||0),0);
const val=(c,ex)=>c.cash+c.land*PLOT+c.dep-c.loan+hold(c,ex);
const allLic=c=>SEC[c.sec].lic.every(n=>c.lic[n]!==undefined&&c.lic[n]<=c.day);
const ipoOk=c=>allLic(c)&&c.day>10&&c.cum>0;
const QS=[[c=>allLic(c),1e4],[c=>c.staff>=3,1e4],[c=>c.land>=1,1e4],[c=>c.pt.length>0,1e4],[c=>!!c.mkd,1e4],[c=>c.listed,25e3],[(c,ex)=>val(c,ex)>=2e6,5e4]];
const newEx=()=>NPC.map(([n,p])=>({n,p,h:[p]}));
const fresh=(name,sec)=>({name,sec,cash:1e6,lic:{},staff:0,land:0,loan:0,dep:0,day:1,cum:0,ad:0,am:1,mkd:0,listed:false,sh:5e5,sold:0,price:FV,hist:[FV],goal:8600,pt:[],q:{},hd:{},nw:[],t:0});
const value=st=>st.co?val(st.co,st.ex):0;
const exch=(c,ev,ex)=>{ex.forEach(x=>{x.p=Math.max(1,+(x.p*(1+(Math.random()-.5)*.06+(ev[1]-1)*.02)).toFixed(2));x.h.push(x.p);if(x.h.length>30)x.h.shift()});
 c.nw.unshift('Day '+c.day+': '+ev[0]);
 if(c.day%8===0&&ex.length<7){const n=NEWIPO[ex.length%4],p=[40,60,80,120][ex.length%4];ex.push({n,p,h:[p],ipo:1});c.nw.unshift('Day '+c.day+': '+n+' lists on the exchange at ₹'+p)}
 c.nw=c.nw.slice(0,5)};
function act(st,a,arg,x){
 const c=st.co;
 if(a==='found'){need(!c,'You already have a company.');need(Object.hasOwn(SEC,x.sec),'Pick a business type.');st.co=fresh(String(x.name||'').trim().slice(0,24)||'My Company',x.sec);st.ex=newEx();return 0}
 if(a==='reset'){need(!c||!c.listed||c.broke,'A listed company cannot be reset.');st.co=null;st.ex=null;return 0}
 need(c,'Start a company first.');need(!c.broke,'Your company is out of cash. Start a new one.');
 const ex=st.ex;let xp=0;
 switch(a){
  case 'lic':need(SEC[c.sec].lic.includes(arg)&&c.lic[arg]===undefined,'Already applied.');need(c.cash>=LIC,'Not enough cash.');c.cash-=LIC;c.lic[arg]=c.day+(hasP(c,'Tech')?1:2);break;
  case 'borrow':need(c.loan+GB<=MAXL,'Loan limit reached.');c.loan+=GB;c.cash+=GB;break;
  case 'repay':{const y=Math.min(GB,c.loan);need(y>0&&c.cash>=y,'Cannot repay that.');c.loan-=y;c.cash-=y;break}
  case 'deposit':need(c.cash>=GB,'Not enough cash.');c.cash-=GB;c.dep+=GB;break;
  case 'withdraw':{const y=Math.min(GB,c.dep);need(y>0,'Nothing saved.');c.dep-=y;c.cash+=y;break}
  case 'hire':need(work(c)<cap(c),'No free desks. Buy land first.');c.staff++;break;
  case 'fire':need(c.staff>0,'No one to let go.');c.staff--;break;
  case 'plot':need(c.land<8&&c.cash>=PLOT,'Cannot buy land right now.');c.cash-=PLOT;c.land++;break;
  case 'mk':{const m=MK[+arg];need(m&&!c.ad&&c.cash>=m[0],'Cannot start that campaign.');c.cash-=m[0];c.ad=m[1];c.am=m[2];c.mkd=1;break}
  case 'sign':{const p=PT[+arg];need(p&&c.pt.length<2&&!c.pt.includes(+arg),'Cannot sign that partner.');c.pt.push(+arg);c.cash+=p.inv;break}
  case 'buyout':{const p=PT[+arg];need(p&&c.pt.includes(+arg)&&c.cash>=p.inv*2,'Cannot buy out that partner.');c.cash-=p.inv*2;c.pt=c.pt.filter(k=>k!==+arg);break}
  case 'claim':{const q=QS[+arg];need(q&&q[0](c,ex)&&!c.q[+arg],'That goal is not finished yet.');c.q[+arg]=1;c.cash+=q[1];xp=20;break}
  case 'buy':{const s=ex.find(k=>k.n===arg);need(s&&c.cash>=s.p*10,'Not enough cash.');c.cash-=s.p*10;const h=c.hd[arg]||{q:0,avg:0};h.avg=(h.avg*h.q+s.p*10)/(h.q+10);h.q+=10;c.hd[arg]=h;break}
  case 'sell':{const s=ex.find(k=>k.n===arg),h=c.hd[arg];need(s&&h,'You do not hold that stock.');c.cash+=h.q*s.p;delete c.hd[arg];break}
  case 'ipo':{const pc=+arg;need([20,30,49].includes(pc)&&!c.listed&&ipoOk(c),'Not ready to list yet.');c.listed=true;c.sold=c.sh*pc/100;c.cash+=c.sold*FV;c.price=FV;c.hist=[FV];xp=100;break}
  case 'day':{need(x.now-(c.t||0)>=1500,'Easy there. Give it a second between days.');c.t=x.now;
   const ev=EV[Math.random()*EV.length|0],ok=allLic(c),bz=x.buzz||0;
   const rev=ok?Math.min(work(c),cap(c))*SEC[c.sec].r*ev[1]*(c.ad>0?c.am||1.15:1)*(hasP(c,'Sales')?1.1:1)*(1+bz)*(.9+Math.random()*.2):0;
   const pay=c.staff*PAY,intr=c.loan*.0005*(hasP(c,'Finance')?.5:1),earn=c.dep*.0002,profit=rev-pay-intr+earn,bonus=profit>=c.goal?5000:0,ps=profit>0?profit*c.pt.reduce((s,i)=>s+PT[i].sh,0):0;
   c.cash+=profit+bonus-ps;c.cum+=profit;c.rep={day:c.day,ev:ev[0],rev,pay,intr,earn,profit,bonus,ps};exch(c,ev,ex);
   c.day++;if(c.ad>0)c.ad--;c.goal=8000+c.day*600;
   if(c.listed){const ch=Math.max(-.08,Math.min(.08,profit/(c.sh*c.price)*10+(Math.random()-.5)*.008+(c.ad>0?.005:0)+bz*.02));c.price=Math.max(1,+(c.price*(1+ch)).toFixed(2));c.hist.push(c.price);if(c.hist.length>60)c.hist.shift()}
   if(c.cash<0)c.broke=1;break}
  default:need(false,'Unknown action.')}
 return xp}

/* ---------- shared market: ticks of 0.05, bid/ask, daily 10% limits, fees, market and limit orders ---------- */
const TICK=.05,FEE=.001,BAND=.1,WALLET=1e6;
const up=x=>+(Math.ceil(x/TICK-1e-9)*TICK).toFixed(2),dn=x=>+(Math.floor(x/TICK+1e-9)*TICK).toFixed(2),tk=x=>+(Math.round(x/TICK)*TICK).toFixed(2);
const SEED=[['KAVF','Kaveri Foods',48,1],['ORBT','Orbit Tech',212,1.3],['MEHR','Meher Textiles',96,.8],['SAGR','Sagar Pharma',60,.7],['NEON','Neon Mobility',120,1.5],['DHRA','Dhara Energy',80,.9],['LOTS','Lotus Retail',40,1.1]];
const quote=s=>{const sp=Math.max(2*TICK,s.price*.002);return{bid:Math.max(TICK,dn(s.price-sp/2)),ask:up(s.price+sp/2)}};
const band=s=>({hi:dn(s.prev*(1+BAND)),lo:up(s.prev*(1-BAND))});
async function ensure(env){const D=env.DB,c=await D.prepare('SELECT COUNT(*) AS n FROM stocks').first();if(!c.n)await D.batch(SEED.map(([sym,name,p,beta])=>D.prepare('INSERT OR IGNORE INTO stocks(sym,name,owner,price,prev,fair,vol,shares,beta) VALUES(?1,?2,NULL,?3,?3,?3,0,10000000,?4)').bind(sym,name,p,beta)))}
async function listCo(D,uid,co){let sy=(co.name.toUpperCase().replace(/[^A-Z]/g,'')+'XXXX').slice(0,4),i=0;while(await D.prepare('SELECT 1 AS x FROM stocks WHERE sym=?1').bind(sy+(i||'')).first())i++;sy+=(i||'');await D.prepare('INSERT INTO stocks(sym,name,owner,price,prev,fair,vol,shares,beta) VALUES(?1,?2,?3,?4,?4,?4,0,?5,1)').bind(sy,co.name,uid,co.price,co.sh).run();return sy}
async function trade(env,uid,s,side,qty,lim){
 const D=env.DB,q=quote(s),bd=band(s),imp=Math.min(.05,.5*qty/s.shares),px=side==='buy'?up(q.ask*(1+imp)):dn(q.bid*(1-imp));
 if(side==='buy'){if(px>bd.hi)throw new GameErr('Upper circuit: no sellers above ₹'+bd.hi.toFixed(2)+'.');if(lim&&px>lim)return null}
 else{if(px<bd.lo)throw new GameErr('Lower circuit: no buyers below ₹'+bd.lo.toFixed(2)+'.');if(lim&&px<lim)return null}
 const h=await D.prepare('SELECT qty,avg FROM holds WHERE uid=?1 AND sym=?2').bind(uid,s.sym).first();
 if(side==='sell')need(h&&h.qty>=qty,'You only hold '+(h?h.qty:0)+' shares.');
 const gross=px*qty,fee=Math.max(1,+(gross*FEE).toFixed(2));
 const ops=side==='buy'
  ?[D.prepare('UPDATE wallets SET cash=cash-?1,realized=realized-?2 WHERE uid=?3').bind(gross+fee,fee,uid),D.prepare('INSERT INTO holds(uid,sym,qty,avg) VALUES(?1,?2,?3,?4) ON CONFLICT(uid,sym) DO UPDATE SET avg=(avg*qty+?4*?3)/(qty+?3),qty=qty+?3').bind(uid,s.sym,qty,px)]
  :[D.prepare('UPDATE wallets SET cash=cash+?1,realized=realized+?2 WHERE uid=?3').bind(gross-fee,(px-h.avg)*qty-fee,uid),D.prepare('UPDATE holds SET qty=qty-?1 WHERE uid=?2 AND sym=?3').bind(qty,uid,s.sym),D.prepare('DELETE FROM holds WHERE uid=?1 AND sym=?2 AND qty=0').bind(uid,s.sym)];
 ops.push(D.prepare('UPDATE stocks SET price=?1,vol=vol+?2 WHERE sym=?3').bind(px,qty,s.sym),D.prepare('INSERT INTO trades(uid,sym,side,qty,px,fee,created) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(uid,s.sym,side,qty,px,fee,Date.now()));
 try{await D.batch(ops)}catch(e){throw new GameErr(side==='buy'?'Not enough cash.':'Not enough shares.')}
 return{px,qty,fee}}
async function tick(env){
 try{await env.DB.prepare('DELETE FROM sessions WHERE exp<?1').bind(Date.now()).run()}catch(e){}
 const D=env.DB;await ensure(env);
 const day=String(Math.floor((Date.now()+19800000)/864e5)),m=await D.prepare("SELECT v FROM meta WHERE k='day'").first();
 if(!m||m.v!==day)await D.batch([D.prepare('UPDATE stocks SET prev=price,vol=0'),D.prepare("INSERT INTO meta(k,v) VALUES('day',?1) ON CONFLICT(k) DO UPDATE SET v=?1").bind(day)]);
 const {results:ss}=await D.prepare('SELECT * FROM stocks').all(),mk=(Math.random()-.5)*.006;
 await D.batch(ss.flatMap(s=>{const bd=band(s),fair=s.owner?s.fair:s.fair*(1+s.beta*mk+(Math.random()-.5)*.004);let p=s.price+.1*(fair-s.price)+s.price*(Math.random()-.5)*.004;p=Math.max(1,Math.min(bd.hi,Math.max(bd.lo,tk(p))));return [D.prepare('UPDATE stocks SET price=?1,fair=?2 WHERE sym=?3').bind(p,fair,s.sym),D.prepare('INSERT OR REPLACE INTO ticks(sym,t,p) VALUES(?1,?2,?3)').bind(s.sym,Math.floor(Date.now()/6e5)*6e5,p)]}));
 await D.prepare('DELETE FROM ticks WHERE t<?1').bind(Date.now()-7*864e5).run();
 const {results:os}=await D.prepare("SELECT id,uid,sym,side,qty,limit_px FROM orders WHERE status='open' ORDER BY id LIMIT 50").all();
 for(const o of os){const s=await D.prepare('SELECT * FROM stocks WHERE sym=?1').bind(o.sym).first();let st='open';
  try{if(await trade(env,o.uid,s,o.side,o.qty,o.limit_px))st='filled'}catch(e){if(e instanceof GameErr)st='cancelled'}
  if(st!=='open')await D.prepare('UPDATE orders SET status=?1 WHERE id=?2').bind(st,o.id).run()}}

async function route(req,env){
 const u=new URL(req.url),p=u.pathname,m=req.method,q=u.searchParams,D=env.DB,ip=req.headers.get('cf-connecting-ip')||'x';let b={};
 if((m==='POST'||m==='PUT')&&p!=='/api/upload'){const t=await req.text();if(t.length>(p==='/api/save'?40000:8000))return J({error:'That is too large.'},413);try{b=JSON.parse(t||'{}')}catch{return J({error:'Bad request.'},400)}}
 if((p==='/api/signup'||p==='/api/login')&&m==='POST')return J({error:'Log in to StockBazar instead. Creator uses the same login.'},410);
 if(p.startsWith('/media/')&&m==='GET'&&env.MEDIA){
  const key=decodeURIComponent(p.slice(7));if(!/^\d+\/[a-f0-9]{32}\.(mp4|webm|mov)$/.test(key))return J({error:'Not found.'},404);
  const o=await env.MEDIA.get(key,{range:req.headers});if(!o)return J({error:'Not found.'},404);
  const h=new Headers();o.writeHttpMetadata(h);h.set('etag',o.httpEtag);h.set('accept-ranges','bytes');h.set('cache-control','public, max-age=31536000, immutable');h.set('x-content-type-options','nosniff');h.set('content-security-policy','sandbox');
  let st=200,len=o.size;
  if(o.range){const r=o.range,off='suffix' in r?o.size-r.suffix:(r.offset??0);len='suffix' in r?r.suffix:(r.length??o.size-off);h.set('content-range','bytes '+off+'-'+(off+len-1)+'/'+o.size);st=206}
  h.set('content-length',String(len));return new Response(o.body,{status:st,headers:h})}
 const me=await who(req,env);if(!me)return J({error:'Please log in.'},401);
 if(p==='/api/me')return J({me:{...pub(me),admin:isAdmin(env,me)}});
 if(p==='/api/page'&&m==='PUT'){
  const name=String(b.name||'').trim().slice(0,40)||me.name,bio=String(b.bio||'').trim().slice(0,160),mode=b.mode==='business'?'business':'creator';
  await D.prepare('UPDATE users SET name=?1,bio=?2,mode=?3 WHERE id=?4').bind(name,bio,mode,me.id).run();return J({me:{handle:me.handle,name,bio,mode,admin:isAdmin(env,me)}})}
 if(p.startsWith('/api/page/')&&m==='GET'){
  const r=await D.prepare('SELECT id,handle,name,bio,mode FROM users WHERE handle=?1').bind(decodeURIComponent(p.slice(10)).toLowerCase()).first();if(!r)return J({error:'No such page.'},404);
  const c=await D.prepare('SELECT (SELECT COUNT(*) FROM posts WHERE uid=?1) AS posts,(SELECT COUNT(*) FROM follows WHERE b=?1) AS followers,(SELECT COUNT(*) FROM follows WHERE a=?1) AS following,EXISTS(SELECT 1 FROM follows WHERE a=?2 AND b=?1) AS followed,EXISTS(SELECT 1 FROM blocks WHERE a=?2 AND b=?1) AS blocked').bind(r.id,me.id).first();
  return J({page:{...pub(r),...c,followed:!!c.followed,blocked:!!c.blocked}})}
 if(p==='/api/posts'&&m==='GET'){
  const tab=Object.hasOwn(COND,q.get('tab'))?q.get('tab'):'feed',t=await D.prepare('SELECT id FROM users WHERE handle=?1').bind((q.get('handle')||me.handle).toLowerCase()).first();if(!t)return J({error:'No such page.'},404);
  const kd=KINDS.find(x=>x===q.get('kind')),before=Number(q.get('before'))||1e15;
  const {results}=await D.prepare(`SELECT p.id,p.kind,p.body,p.link,p.remix,p.created,u.handle,u.name,c.handle AS collab,(SELECT COUNT(*) FROM likes l WHERE l.post=p.id) AS likes,EXISTS(SELECT 1 FROM likes l WHERE l.post=p.id AND l.uid=?1) AS liked FROM posts p JOIN users u ON u.id=p.uid LEFT JOIN users c ON c.id=p.collab WHERE p.id<?3 AND (SELECT COUNT(DISTINCT r.uid) FROM reports r WHERE r.post=p.id AND r.done=0)<3 AND NOT EXISTS(SELECT 1 FROM blocks k WHERE k.a=?1 AND k.b=p.uid) AND NOT EXISTS(SELECT 1 FROM banned bn WHERE bn.uid=p.uid) AND ${COND[tab]}${kd?` AND p.kind='${kd}'`:''} ORDER BY p.id DESC LIMIT 30`).bind(me.id,t.id,before).all();
  return J({posts:results.map(x=>({...x,liked:!!x.liked}))})}
 if(p==='/api/posts'&&m==='POST'){
  if(!await ok(env.POST_RL,'p:'+me.id))return J({error:'Slow down for a minute.'},429);
  const kind=KINDS.includes(b.kind)?b.kind:'post',body=String(b.body||'').trim().slice(0,1000);if(!body)return J({error:'Write something first.'},400);
  let link='';if(b.link){try{const x=new URL(String(b.link).trim());if(x.protocol==='https:'||x.protocol==='http:')link=x.href.slice(0,300)}catch{return J({error:'That link does not look right.'},400)}}
  if(b.media){const k=String(b.media);if(!k.startsWith(me.id+'/')||!/^\d+\/[a-f0-9]{32}\.(mp4|webm|mov)$/.test(k)||!env.MEDIA||!await env.MEDIA.head(k))return J({error:'That upload was not found. Try again.'},400);link='r2:'+k}
  let remix=null;if(b.remix){const r=await D.prepare('SELECT id FROM posts WHERE id=?1').bind(+b.remix).first();remix=r?.id??null}
  let collab=null;if(b.collab){const r=await D.prepare('SELECT id FROM users WHERE handle=?1').bind(String(b.collab).trim().replace(/^@/,'').toLowerCase()).first();if(!r)return J({error:'Collab partner not found.'},404);collab=r.id}
  const id=(await D.prepare('INSERT INTO posts(uid,kind,body,link,remix,collab,created) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(me.id,kind,body,link,remix,collab,Date.now()).run()).meta.last_row_id;
  const hs=[...new Set([...body.toLowerCase().matchAll(/@([a-z0-9_]{3,20})/g)].map(x=>x[1]))].slice(0,5);
  if(hs.length)await D.batch(hs.map(h=>D.prepare('INSERT OR IGNORE INTO tags(post,uid) SELECT ?1,id FROM users WHERE handle=?2').bind(id,h)));
  return J({id})}
 if(p==='/api/like'&&m==='POST'){
  const id=+b.post;if(!id)return J({error:'Bad request.'},400);
  const d=await D.prepare('DELETE FROM likes WHERE post=?1 AND uid=?2').bind(id,me.id).run();
  if(!d.meta.changes)await D.prepare('INSERT OR IGNORE INTO likes(post,uid) SELECT ?1,?2 WHERE EXISTS(SELECT 1 FROM posts WHERE id=?1)').bind(id,me.id).run();
  return J({liked:!d.meta.changes})}
 if(p==='/api/follow'&&m==='POST'){
  const t=await D.prepare('SELECT id FROM users WHERE handle=?1').bind(String(b.handle||'').toLowerCase()).first();if(!t||t.id===me.id)return J({error:'Bad request.'},400);
  const d=await D.prepare('DELETE FROM follows WHERE a=?1 AND b=?2').bind(me.id,t.id).run();
  if(!d.meta.changes)await D.prepare('INSERT INTO follows(a,b) VALUES(?1,?2)').bind(me.id,t.id).run();
  return J({followed:!d.meta.changes})}
 if(p==='/api/chats'&&m==='GET'){
  const {results}=await D.prepare('SELECT u.handle,u.name,m.body,m.created,m.a=?1 AS mine FROM msgs m JOIN users u ON u.id=CASE WHEN m.a=?1 THEN m.b ELSE m.a END WHERE m.id IN (SELECT MAX(id) FROM msgs WHERE a=?1 OR b=?1 GROUP BY CASE WHEN a=?1 THEN b ELSE a END) ORDER BY m.id DESC LIMIT 30').bind(me.id).all();
  return J({chats:results.map(x=>({...x,mine:!!x.mine}))})}
 if(p.startsWith('/api/chat/')){
  const t=await D.prepare('SELECT id FROM users WHERE handle=?1').bind(decodeURIComponent(p.slice(10)).toLowerCase()).first();if(!t||t.id===me.id)return J({error:'No such page.'},404);
  const bl=await D.prepare('SELECT 1 AS x FROM blocks WHERE (a=?1 AND b=?2) OR (a=?2 AND b=?1)').bind(me.id,t.id).first();if(bl&&m!=='POST')return J({msgs:[]});
  if(m==='POST'){
   if(bl)return J({error:'You cannot message this person.'},403);
   if(!await ok(env.CHAT_RL,'c:'+me.id))return J({error:'Slow down for a moment.'},429);
   const body=String(b.body||'').trim().slice(0,500);if(!body)return J({error:'Write a message first.'},400);
   const now=Date.now(),id=(await D.prepare('INSERT INTO msgs(a,b,body,created) VALUES(?1,?2,?3,?4)').bind(me.id,t.id,body,now).run()).meta.last_row_id;
   return J({msg:{id,body,created:now,mine:true}})}
  const {results}=await D.prepare('SELECT id,body,created,a=?1 AS mine FROM msgs WHERE ((a=?1 AND b=?2) OR (a=?2 AND b=?1)) AND id>?3 ORDER BY id DESC LIMIT 50').bind(me.id,t.id,Number(q.get('after'))||0).all();
  return J({msgs:results.reverse().map(x=>({...x,mine:!!x.mine}))})}
 if(p==='/api/ai'&&m==='POST'){
  const sk=SK[+b.skill],inp=String(b.input||'').trim().slice(0,1200);if(!sk||!inp)return J({error:'Pick a skill and describe your idea.'},400);
  if(!await ok(env.POST_RL,'a:'+me.id))return J({error:'Slow down for a minute.'},429);
  if(!env.ANTHROPIC_API_KEY)return J({text:'Demo mode: the owner has not added an Anthropic key to this Worker yet.'});
  const n=(await D.prepare('INSERT INTO ai_use(uid,day,n) VALUES(?1,?2,1) ON CONFLICT(uid,day) DO UPDATE SET n=n+1 RETURNING n').bind(me.id,new Date().toISOString().slice(0,10)).all()).results[0].n;
  if(n>30)return J({error:'You have used all 30 AI requests for today. Come back tomorrow.'},429);
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:env.ANTHROPIC_MODEL||'claude-sonnet-5-5',max_tokens:700,system:BASE+sk[1],messages:[{role:'user',content:inp}]})});
  if(!r.ok)return J({error:'The assistant is busy. Try again soon.'},502);
  const j=await r.json();return J({text:(j.content||[]).map(x=>x.text||'').join('').trim()||'No answer came back. Try rephrasing.'})}
 if(p==='/api/upload'&&m==='POST'){
  if(!env.MEDIA)return J({error:'Uploads are not set up yet.'},503);
  const ty=(req.headers.get('content-type')||'').split(';')[0],ext={'video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov'}[ty],len=+req.headers.get('content-length');
  if(!ext)return J({error:'Use an MP4, WebM or MOV video.'},415);
  if(!len||len>60*1048576)return J({error:'Videos can be up to 60 MB.'},413);
  if(!await ok(env.POST_RL,'u:'+me.id))return J({error:'Slow down for a minute.'},429);
  const n=(await D.prepare('INSERT INTO ai_use(uid,day,n) VALUES(?1,?2,1) ON CONFLICT(uid,day) DO UPDATE SET n=n+1 RETURNING n').bind(me.id,'u'+new Date().toISOString().slice(0,10)).all()).results[0].n;
  if(n>10)return J({error:'You can upload 10 videos a day.'},429);
  const key=me.id+'/'+rnd(16)+'.'+ext;await env.MEDIA.put(key,req.body,{httpMetadata:{contentType:ty}});
  const o=await env.MEDIA.get(key,{range:{offset:0,length:12}}),h=new Uint8Array(await o.arrayBuffer());
  if(!(String.fromCharCode(...h.slice(4,8))==='ftyp'||(h[0]===0x1a&&h[1]===0x45&&h[2]===0xdf&&h[3]===0xa3))){await env.MEDIA.delete(key);return J({error:'That file is not a real video.'},415)}
  return J({key})}
 if(p==='/api/posts/delete'&&m==='POST'){
  const r=await D.prepare('SELECT id,link FROM posts WHERE id=?1 AND uid=?2').bind(+b.post,me.id).first();if(!r)return J({error:'Post not found.'},404);
  await D.batch([D.prepare('DELETE FROM posts WHERE id=?1').bind(r.id),D.prepare('DELETE FROM tags WHERE post=?1').bind(r.id),D.prepare('DELETE FROM likes WHERE post=?1').bind(r.id)]);
  if(r.link.startsWith('r2:')&&env.MEDIA)await env.MEDIA.delete(r.link.slice(3));
  return J({ok:true})}
 if(p.startsWith('/api/market')){
  await ensure(env);await D.prepare('INSERT OR IGNORE INTO wallets(uid,cash) VALUES(?1,?2)').bind(me.id,WALLET).run();
  if(p==='/api/market'&&m==='GET'){
   const {results:ss}=await D.prepare('SELECT * FROM stocks ORDER BY owner IS NOT NULL,sym').all(),w=await D.prepare('SELECT cash,realized FROM wallets WHERE uid=?1').bind(me.id).first(),{results:hs}=await D.prepare('SELECT sym,qty,avg FROM holds WHERE uid=?1').bind(me.id).all();
   return J({stocks:ss.map(s=>({sym:s.sym,name:s.name,price:s.price,prev:s.prev,vol:s.vol,shares:s.shares,mine:s.owner===me.id,player:s.owner!=null,...quote(s),...band(s)})),wallet:w,holds:hs})}
  if(p==='/api/market/order'&&m==='POST'){
   if(!await ok(env.GAME_RL,'o:'+me.id))return J({error:'Too fast. Wait a few seconds.'},429);
   const s=await D.prepare('SELECT * FROM stocks WHERE sym=?1').bind(String(b.sym||'')).first(),side=b.side==='sell'?'sell':'buy',qty=Math.floor(+b.qty);
   if(!s||!(qty>=1&&qty<=10000))return J({error:'Quantity must be 1 to 10,000.'},400);
   try{let lim=null;
    if(b.type==='limit'){lim=+b.px;need(lim>0&&Math.abs(lim/TICK-Math.round(lim/TICK))<1e-6,'Price must be a multiple of ₹0.05.');const bd=band(s);need(lim>=bd.lo&&lim<=bd.hi,'Price must be inside the daily 10% limits.')}
    const r=await trade(env,me.id,s,side,qty,lim);if(r)return J({trade:r});
    const n=await D.prepare("SELECT COUNT(*) AS n FROM orders WHERE uid=?1 AND status='open'").bind(me.id).first();need(n.n<5,'You can have 5 open orders at a time.');
    await D.prepare("INSERT INTO orders(uid,sym,side,qty,limit_px,status,created) VALUES(?1,?2,?3,?4,?5,'open',?6)").bind(me.id,s.sym,side,qty,lim,Date.now()).run();return J({order:true})
   }catch(e){return J({error:e instanceof GameErr?e.message:'That did not work.'},400)}}
  if(p==='/api/market/chart'){const sy=String(q.get('sym')||''),s=await D.prepare('SELECT price FROM stocks WHERE sym=?1').bind(sy).first();if(!s)return J({error:'No such stock.'},404);
   const day=q.get('tf')==='d',bk=day?864e5:36e5,off=day?19800000:0,{results:t}=await D.prepare('SELECT t,p FROM ticks WHERE sym=?1 AND t>?2 ORDER BY t').bind(sy,Date.now()-7*864e5).all(),mp=new Map();
   for(const r of t.concat([{t:Date.now(),p:s.price}])){const k=Math.floor((r.t+off)/bk),c=mp.get(k);if(!c)mp.set(k,[k,r.p,r.p,r.p,r.p]);else{c[2]=Math.max(c[2],r.p);c[3]=Math.min(c[3],r.p);c[4]=r.p}}
   return J({candles:[...mp.values()].slice(-24).map(([k,o,h,l,c])=>[k*bk-off,o,h,l,c])})}
  if(p==='/api/market/cancel'&&m==='POST'){await D.prepare("UPDATE orders SET status='cancelled' WHERE id=?1 AND uid=?2 AND status='open'").bind(+b.id,me.id).run();return J({ok:true})}
  if(p==='/api/market/orders'){const {results:o}=await D.prepare("SELECT id,sym,side,qty,limit_px FROM orders WHERE uid=?1 AND status='open' ORDER BY id DESC").bind(me.id).all(),{results:t}=await D.prepare('SELECT sym,side,qty,px,fee FROM trades WHERE uid=?1 ORDER BY id DESC LIMIT 15').bind(me.id).all();return J({orders:o,trades:t})}
  if(p==='/api/market/top'){const {results:tr}=await D.prepare('SELECT u.handle,u.name,w.cash+COALESCE((SELECT SUM(h.qty*s.price) FROM holds h JOIN stocks s ON s.sym=h.sym WHERE h.uid=w.uid),0) AS nw FROM wallets w JOIN users u ON u.id=w.uid WHERE NOT EXISTS(SELECT 1 FROM banned b WHERE b.uid=u.id) ORDER BY nw DESC LIMIT 10').all(),{results:co}=await D.prepare('SELECT s.sym,s.name,s.price*s.shares AS cap,u.handle FROM stocks s JOIN users u ON u.id=s.owner ORDER BY cap DESC LIMIT 10').all();return J({traders:tr,companies:co})}}
 if(p==='/api/game'&&m==='GET'){const r=await D.prepare('SELECT data FROM biz WHERE uid=?1').bind(me.id).first(),st=r?JSON.parse(r.data):{co:null,ex:null};if(st.co&&st.co.sym){const s=await D.prepare('SELECT price FROM stocks WHERE sym=?1').bind(st.co.sym).first();if(s)st.co.price=s.price}return J({co:st.co,ex:st.ex})}
 if(p==='/api/game/act'&&m==='POST'){
  if(!await ok(env.GAME_RL,'g:'+me.id))return J({error:'Too fast. Wait a few seconds.'},429);
  const r=await D.prepare('SELECT data,ver FROM biz WHERE uid=?1').bind(me.id).first(),st=r?JSON.parse(r.data):{co:null,ex:null};let buzz=0;
  if(b.a==='day'&&me.mode==='business'){const z=await D.prepare('SELECT COUNT(*) AS n FROM likes l JOIN posts p ON p.id=l.post WHERE p.uid=?1 AND p.created>?2').bind(me.id,Date.now()-7*864e5).first();buzz=Math.min(.3,z.n/200)}
  const was=st.co&&st.co.sym?{sym:st.co.sym}:null,mk0=st.co&&st.co.listed&&st.co.sym?await D.prepare('SELECT price FROM stocks WHERE sym=?1').bind(st.co.sym).first():null;if(mk0)st.co.price=mk0.price;
  let xp=0;try{xp=act(st,String(b.a),b.arg,{name:b.name,sec:b.sec,buzz,now:Date.now()})}catch(e){return J({error:e instanceof GameErr?e.message:'That did not work.'},400)}
  if(st.co&&st.co.listed){
   if(!st.co.sym)st.co.sym=await listCo(D,me.id,st.co);
   else if(b.a==='day'&&mk0){await D.prepare('UPDATE stocks SET fair=?1 WHERE sym=?2').bind(st.co.price,st.co.sym).run();st.co.price=mk0.price}}
  if(b.a==='reset'&&was){const s=await D.prepare('SELECT price FROM stocks WHERE sym=?1').bind(was.sym).first();if(s)await D.batch([D.prepare('UPDATE wallets SET cash=cash+COALESCE((SELECT h.qty*?1 FROM holds h WHERE h.uid=wallets.uid AND h.sym=?2),0) WHERE uid IN (SELECT uid FROM holds WHERE sym=?2)').bind(Math.max(1,s.price*.1),was.sym),D.prepare('DELETE FROM holds WHERE sym=?1').bind(was.sym),D.prepare("UPDATE orders SET status='cancelled' WHERE sym=?1").bind(was.sym),D.prepare('DELETE FROM stocks WHERE sym=?1').bind(was.sym)])}
  const d=JSON.stringify(st),v=Math.round(value(st)),w=r?await D.prepare('UPDATE biz SET data=?1,val=?2,ver=ver+1 WHERE uid=?3 AND ver=?4').bind(d,v,me.id,r.ver).run():await D.prepare('INSERT OR IGNORE INTO biz(uid,data,val,ver) VALUES(?1,?2,?3,1)').bind(me.id,d,v).run();
  if(!w.meta.changes)return J({error:'Please try again.'},409);
  return J({co:st.co,ex:st.ex,xp})}
 if(p==='/api/report'&&m==='POST'){
  if(!await ok(env.POST_RL,'r:'+me.id))return J({error:'Slow down for a minute.'},429);
  const r=await D.prepare('SELECT id,uid FROM posts WHERE id=?1').bind(+b.post).first();if(!r||r.uid===me.id)return J({error:'Post not found.'},404);
  const why=['spam','harassment','unsafe'].includes(b.reason)?b.reason:'other';
  if(!await D.prepare('SELECT 1 AS x FROM reports WHERE uid=?1 AND post=?2').bind(me.id,r.id).first())await D.prepare('INSERT INTO reports(uid,post,target,reason,created) VALUES(?1,?2,?3,?4,?5)').bind(me.id,r.id,r.uid,why,Date.now()).run();
  return J({ok:true})}
 if(p==='/api/block'&&m==='POST'){
  const t=await D.prepare('SELECT id FROM users WHERE handle=?1').bind(String(b.handle||'').toLowerCase()).first();if(!t||t.id===me.id)return J({error:'Bad request.'},400);
  const d=await D.prepare('DELETE FROM blocks WHERE a=?1 AND b=?2').bind(me.id,t.id).run();
  if(!d.meta.changes)await D.batch([D.prepare('INSERT INTO blocks(a,b) VALUES(?1,?2)').bind(me.id,t.id),D.prepare('DELETE FROM follows WHERE (a=?1 AND b=?2) OR (a=?2 AND b=?1)').bind(me.id,t.id)]);
  return J({blocked:!d.meta.changes})}
 if(p.startsWith('/api/admin/')){
  if(!isAdmin(env,me))return J({error:'Not allowed.'},403);
  if(p==='/api/admin/reports'){const {results}=await D.prepare('SELECT r.id,r.reason,r.post,u.handle,p.body,p.link,(SELECT COUNT(DISTINCT x.uid) FROM reports x WHERE x.post=r.post AND x.done=0) AS n FROM reports r JOIN posts p ON p.id=r.post JOIN users u ON u.id=p.uid WHERE r.done=0 GROUP BY r.post ORDER BY n DESC,r.id DESC LIMIT 30').all();return J({reports:results})}
  if(p==='/api/admin/act'&&m==='POST'){
   const r=await D.prepare('SELECT r.post,p.uid,p.link FROM reports r JOIN posts p ON p.id=r.post WHERE r.id=?1').bind(+b.report).first();if(!r)return J({error:'Report not found.'},404);
   if(b.action==='remove'||b.action==='ban'){await D.batch([D.prepare('DELETE FROM posts WHERE id=?1').bind(r.post),D.prepare('DELETE FROM tags WHERE post=?1').bind(r.post),D.prepare('DELETE FROM likes WHERE post=?1').bind(r.post)]);if(r.link.startsWith('r2:')&&env.MEDIA)await env.MEDIA.delete(r.link.slice(3))}
   if(b.action==='ban')await D.batch([D.prepare('INSERT OR IGNORE INTO banned(uid) VALUES(?1)').bind(r.uid),D.prepare('DELETE FROM sessions WHERE uid=?1').bind(r.uid)]);
   await D.prepare('UPDATE reports SET done=1 WHERE post=?1').bind(r.post).run();return J({ok:true})}}
 if(p==='/api/buzz'){const r=me.mode==='business'?await D.prepare('SELECT COUNT(*) AS n FROM likes l JOIN posts p ON p.id=l.post WHERE p.uid=?1 AND p.created>?2').bind(me.id,Date.now()-7*864e5).first():null;return J({likes:r?r.n:0})}
 if(p==='/api/save'){
  if(m==='GET'){const r=await D.prepare('SELECT data FROM saves WHERE uid=?1').bind(me.id).first();return J({save:r?{data:JSON.parse(r.data)}:null})}
  if(m==='PUT'){const d=JSON.stringify(b.data||{});await D.prepare('INSERT INTO saves(uid,data,updated) VALUES(?1,?2,?3) ON CONFLICT(uid) DO UPDATE SET data=?2,updated=?3').bind(me.id,d,Date.now()).run();return J({ok:true})}}
 return J({error:'Not found.'},404)}

export default{async fetch(req,env){
 const o=req.headers.get('origin'),h=(env.ALLOWED_ORIGIN||'').split(',').includes(o)?{'access-control-allow-origin':o,'access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,PUT,OPTIONS','vary':'origin'}:{};
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:h});
 let r;try{r=await route(req,env)}catch(e){r=J({error:'Server error.'},500)}
 for(const k in h)r.headers.set(k,h[k]);return r},
async scheduled(e,env,ctx){ctx.waitUntil(tick(env))}};
