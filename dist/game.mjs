import {Economy,key,cell,directions} from './economy.mjs';

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STORE='tideline-naiwa-v1', TILE=1.42;
const canvas=$('#sea'),ctx=canvas.getContext('2d');
let game,characters,images={},mode='collect',rotation=0,paused=false,selectedGuide='renbo',lastStage='',saveBlocked=false;
let w=0,h=0,dpr=1,zoom=53,yaw=.65,pan={x:0,z:0},hero={x:0,z:0,cell:'0,0',path:[],flip:false},pointer={x:-999,y:-999},hover=null;
let time=0,lastFrame=0,uiClock=0,spawnClock=0,saveClock=0,toastTimer,resources=[],boats=new Map(),keys=new Set(),dialogPreviousPause=false;
let storageWorks=true,started=false,drag=null,dragged=false;
let lastVoyage=false;

const costText=cost=>Object.entries(cost).map(([id,n])=>`${game.items[id].name} ${n}`).join(' · ');
function notify(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),3300);}
function stage(){return !game.has('workshop')?'start':!game.trades?'craft':game.reputation<3?'trade':'grow';}
function setGuide(id){selectedGuide=id;renderGuide();}
function renderGuide(){
  const current=stage();if(current!==lastStage){selectedGuide=['start','grow'].includes(current)?'renbo':'chaorui';lastStage=current;}
  const guide=characters.guides.find(g=>g.id===selectedGuide);$('#guide-image').src=guide.image;$('#guide-image').alt=guide.name;
  $('#guide-name').textContent=`${guide.name} / ${guide.role}`;$('#guide-line').textContent=guide.lines[current];
  if(game.atSea()){$('#guide-name').textContent=`${guide.name} / 海上打捞`;$('#guide-line').textContent='奶娃，点击「随机打捞」收集物资，每次结果都不同。偶尔漂来的物资也能直接拾取。航行结束会自动返航。';}
  $$('[data-guide]').forEach(b=>b.classList.toggle('active',b.dataset.guide===selectedGuide));
}
function renderRecipes(){
  for(const r of Object.values(game.recipes)){
    const card=$(`[data-recipe="${r.id}"]`);card.querySelector('.owned').textContent=`×${game.count(r.output)}`;
    const error=game.craftError(r.id),button=card.querySelector('button');button.disabled=paused||Boolean(error);
    button.textContent=game.reputation<r.reputation?`声望 ${r.reputation} 解锁`:`制作 · ${r.seconds} 秒`;button.title=error||costText(r.cost);
    const active=game.queue[0]?.recipe===r.id;card.querySelector('.progress i').style.width=active?`${(1-game.queue[0].remaining/r.seconds)*100}%`:'0%';
  }
  $('#workshop-status').textContent=game.has('workshop')?'可制作':'待建造';
  $('#queue').textContent=`制作队列 ${game.queue.length} / ${game.settings.queue_limit}`+(game.queue.length?'\n'+game.queue.map(t=>game.items[game.recipes[t.recipe].output].name).join(' → '):'');
  $('#capacity').textContent=`原料仓 ${game.rawTotal()} / ${game.capacity()} · 浮岛 ${game.tiles.size} 格`;
}
function renderVisitors(){
  $('#order-count').textContent=`${game.visitors.length} / 3`;
  $('#mobile-order-count').textContent=game.visitors.length;
  for(let slot=0;slot<3;slot++){
    const el=$(`[data-slot="${slot}"]`),v=game.visitors.find(v=>v.slot===slot),button=el.querySelector('button');
    el.classList.toggle('empty',!v);
    if(!v){el.querySelector('h3').textContent='空闲泊位';el.querySelector('small').textContent='';el.querySelector('.order').textContent='下一位顾客正在途中…';button.textContent='等待到港';button.disabled=true;continue;}
    const npc=game.npcs[v.npc];el.style.setProperty('--npc-color',`#${npc.color}`);el.querySelector('h3').textContent=npc.name;
    const left=Math.max(0,Math.ceil(v.remaining));el.querySelector('small').textContent=`${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`;
    el.querySelector('.order').textContent=`${game.items[v.item].name} ×${v.quantity}　持有 ${game.count(v.item)}`;
    const error=game.tradeError(slot);button.disabled=paused||Boolean(error);button.textContent=v.age<2?'正在靠岸…':error?`备货中 · 报酬 ${v.reward} 金`:`交付 +${v.reward} 金币`;
  }
}
function renderVendor(){
  const vendor=game.vendors.food_supplier;$('#food-vendor-name').textContent=vendor.name;$('#food-description').textContent=vendor.description;
  $('#food-wallet').textContent=`奶娃的金币：${game.coins}　·　食堂营业中`;
  if(game.atSea())$('#food-wallet').textContent=`出海途中 · 体力 ${game.stamina} / ${game.settings.max_stamina}`;
  const eatError=game.eatError();$('#eat-food').disabled=Boolean(eatError);$('#eat-food').textContent=eatError||`吃一份猪脚饭 · 体力 +${game.settings.food_stamina_restore}`;
  $('#food-count').textContent=game.count('pork_rice');
  vendor.offers.forEach((offer,i)=>{const card=$(`[data-offer="${i}"]`),error=game.purchaseError(vendor.id,i);card.querySelector('.food-owned').textContent=`背包已有 ${game.count(offer.item)} 份`;const b=card.querySelector('button');b.disabled=Boolean(error);b.textContent=error||`购买 ${offer.quantity} 份 · ${offer.price} 金币`;});
}
function render(){
  if(!started)return;
  const atSea=game.atSea();if(atSea!==lastVoyage){lastVoyage=atSea;resources=[];spawnClock=0;pan={x:0,z:0};hero.path=[];if(atSea)spawnResource();}
  for(const id of Object.keys(game.items)){$(`[data-count="${id}"]`)?.replaceChildren(document.createTextNode(game.count(id)));}
  $('[data-count="coins"]').textContent=game.coins;$('[data-count="reputation"]').textContent=String(game.reputation).padStart(2,'0');
  $('#pause').textContent=paused?'继续':'暂停';renderGuide();renderRecipes();renderVisitors();renderVendor();
  renderJourney();updateHint();
  if(game.structures[hero.cell]){hero.cell=[...game.tiles].find(k=>!game.structures[k]&&k!==game.reservedCell())||hero.cell;[hero.x,hero.z]=cell(hero.cell).map(n=>n*TILE);hero.path=[];}
}
function selectMode(id){if(game.atSea()&&id!=='collect'){notify('返航后才能建造');return;}mode=id;$$('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===id));setSheet('none');updateHint();}
function renderJourney(){
  $('#stamina-count').textContent=`体力 ${game.stamina} / ${game.settings.max_stamina}`;
  const wait=Math.max(0,Math.ceil((game.settings.stamina_regen_seconds*1000-(Date.now()-game.staminaAt))/1000));
  $('#stamina-recovery').textContent=game.stamina===game.settings.max_stamina?'每小时回复 1 点':`${Math.floor(wait/60)}:${String(wait%60).padStart(2,'0')} 后回复 1 点`;
  const b=$('#voyage-button'),left=Math.max(0,Math.ceil((game.voyageUntil-Date.now())/1000));b.textContent=game.atSea()?`返航 · 剩余 ${left} 秒`:'出海 · 消耗 1 体力';b.disabled=paused||(!game.atSea()&&game.stamina<game.settings.voyage_stamina_cost);
  const salvage=$('#salvage-button'),error=game.salvageError();salvage.hidden=!game.atSea();salvage.textContent=error||'随机打捞';salvage.disabled=paused||Boolean(error);
}
function updateHint(){
  $('#mode-hint').textContent=game.atSea()?'随机打捞为主 · 海面偶遇物资可直接拾取':mode==='collect'?'小岛上无法打捞 · 点击出海，或吃饭补充体力':hover?game.placementError(mode,hover)||(mode==='expand'?'点击扩建平台':`点击建造${game.buildings[mode].name} · R 旋转`):'点击空平台放置，右键取消';
}
function setSheet(name){$('#craft-panel').classList.toggle('active',name==='craft');$('#orders-panel').classList.toggle('active',name==='orders');$$('[data-sheet]').forEach(b=>b.classList.toggle('active',b.dataset.sheet===name));}
function openDialog(id){
  if($('#food-dialog').open||$('#new-dialog').open)return;dialogPreviousPause=paused;paused=true;render();$(id).showModal();keys.clear();
}
function closeDialog(id){$(id).close();paused=dialogPreviousPause;render();}
function save(manual=false){
  if(saveBlocked){if(manual)notify('原存档无法读取。先下载备份，再通过「新局」确认重置。');return;}
  try{const previous=localStorage.getItem(STORE);if(previous)localStorage.setItem(`${STORE}-backup`,previous);localStorage.setItem(STORE,JSON.stringify(game.snapshot()));storageWorks=true;$('#save-status').textContent='已保存到当前浏览器';if(manual)notify('进度已保存');}
  catch{storageWorks=false;$('#save-status').textContent='存储不可用，请下载存档';if(manual)notify('浏览器禁止本地存储，可通过新局窗口下载存档。');}
}
function pathTo(goal){
  if(!game.tiles.has(goal)||game.structures[goal]||goal===game.reservedCell())return;
  const parents=new Map([[hero.cell,null]]),front=[hero.cell];for(let i=0;i<front.length&&!parents.has(goal);i++){const[x,z]=cell(front[i]);for(const[dx,dz]of directions){const next=key(x+dx,z+dz);if(!game.tiles.has(next)||game.structures[next]||next===game.reservedCell()||parents.has(next))continue;parents.set(next,front[i]);front.push(next);}}
  if(!parents.has(goal))return;hero.path=[];for(let p=goal;p!==hero.cell;p=parents.get(p))hero.path.unshift(p);
}
function setupUI(){
  $('#resources').innerHTML=Object.values(game.items).filter(i=>i.kind==='resource').map(i=>`<div class="resource"><small>${escape(i.name)}</small><strong data-count="${escape(i.id)}">0</strong></div>`).join('')+'<div class="resource gold"><small>金币</small><strong data-count="coins">80</strong></div><div class="resource rep"><small>声望</small><strong data-count="reputation">00</strong></div>';
  $('#recipes').innerHTML=Object.values(game.recipes).map(r=>`<article class="recipe" data-recipe="${escape(r.id)}"><div class="recipe-heading"><h3>${escape(game.items[r.output].name)}</h3><span class="owned">×0</span></div><p class="cost">${escape(costText(r.cost))}</p><button class="primary">制作</button><div class="progress"><i></i></div></article>`).join('');
  for(const r of Object.values(game.recipes))$(`[data-recipe="${r.id}"] button`).onclick=()=>{if(paused)return;const error=game.craft(r.id);notify(error||'已加入制作队列');};
  $('#visitors').innerHTML=Array.from({length:3},(_,slot)=>`<article class="visitor" data-slot="${slot}"><div class="visitor-heading"><h3>空闲泊位</h3><small></small></div><p class="order"></p><button class="primary">等待到港</button></article>`).join('');
  $$('[data-slot] button').forEach(b=>b.onclick=()=>{if(!paused){const error=game.trade(Number(b.closest('[data-slot]').dataset.slot));if(error)notify(error);}});
  const entries=[{id:'collect',name:'航行打捞',detail:'出海后收集物资'},{id:'expand',name:'扩建平台',detail:costText(game.settings.expansion_cost)},...Object.values(game.buildings).map(b=>({id:b.id,name:b.name,detail:`${costText(b.cost)} · ${b.coins} 金`}))];
  $('#build-tools').innerHTML=entries.map(b=>`<button data-mode="${b.id}" class="${b.id===mode?'active':''}">${escape(b.name)}<span>${escape(b.detail)}</span></button>`).join('');
  $$('[data-mode]').forEach(b=>b.onclick=()=>selectMode(b.dataset.mode));
  $$('[data-guide]').forEach(b=>b.onclick=()=>setGuide(b.dataset.guide));
  $$('[data-sheet]').forEach(b=>b.onclick=()=>{const panel=b.dataset.sheet;const active=panel!=='none'&&$(`#${panel==='craft'?'craft':'orders'}-panel`).classList.contains('active');setSheet(active?'none':panel);});
  const offers=game.vendors.food_supplier.offers;
  $('#food-offers').innerHTML=offers.map((o,i)=>`<article class="food-offer" data-offer="${i}"><div class="food-offer-heading"><strong>${escape(game.items[o.item].name)}</strong><span>${o.price} 金币 / 份</span></div><p class="food-owned"></p><button class="primary">购买</button></article>`).join('');
  $$('[data-offer] button').forEach(b=>b.onclick=()=>{const error=game.buy('food_supplier',Number(b.closest('[data-offer]').dataset.offer));if(error)notify(error);else{renderVendor();save();}});
  $('#food-open').onclick=$('#food-mobile').onclick=()=>{setSheet('none');openDialog('#food-dialog');};
  $('#food-close').onclick=()=>closeDialog('#food-dialog');
  $('#eat-food').onclick=()=>{const error=game.eatFood();if(error)notify(error);else save();};
  $('#voyage-button').onclick=()=>{if(paused)return;if(game.atSea()){game.returnHome();}else{mode='collect';selectMode('collect');const error=game.beginVoyage();notify(error||'奶娃出海了！体力 -1，本次航行 60 秒');}save();};
  $('#salvage-button').onclick=()=>{if(paused)return;const result=game.salvage();notify(result.error||`随机打捞：${game.items[result.item].name} +${result.amount}`);if(!result.error)save();};
  $('#pause').onclick=()=>{paused=!paused;render();};$('#save').onclick=()=>save(true);$('#new').onclick=()=>openDialog('#new-dialog');$('#cancel-new').onclick=()=>closeDialog('#new-dialog');
  $('#confirm-new').onclick=()=>{game.reset();hero={x:0,z:0,cell:'0,0',path:[],flip:false};saveBlocked=false;resources=[];boats.clear();for(let i=0;i<19;i++)spawnResource();lastStage='';pan={x:0,z:0};mode='collect';dialogPreviousPause=false;closeDialog('#new-dialog');selectMode('collect');save();notify('奶娃的新航程开始了');};
  $('#backup').onclick=()=>{let data;try{data=saveBlocked?localStorage.getItem(STORE):JSON.stringify(game.snapshot(),null,2);}catch{}const url=URL.createObjectURL(new Blob([data||JSON.stringify(game.snapshot(),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='潮汐集市-存档.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  for(const id of ['#food-dialog','#new-dialog'])$(id).addEventListener('cancel',event=>{event.preventDefault();closeDialog(id);});
}

function resize(){w=innerWidth;h=innerHeight;dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);}
function scale(){return zoom*(w<=860?Math.min(1,w/690):Math.min(1,w/1340));}
function project(x,z,y=0){const dx=x-pan.x,dz=z-pan.z,s=scale(),c=Math.cos(yaw),sn=Math.sin(yaw);return {x:w*.5+(dx*c-dz*sn)*s,y:h*(w<=860?.53:.51)+(dx*sn+dz*c)*s*.52-y*s};}
function unproject(px,py){const s=scale(),a=(px-w*.5)/s,b=(py-h*(w<=860?.53:.51))/(s*.52),c=Math.cos(yaw),sn=Math.sin(yaw);return {x:a*c+b*sn+pan.x,z:-a*sn+b*c+pan.z};}
function polygon(points,fill,stroke){ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.fillStyle=fill;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=.7;ctx.stroke();}}
function brighten(hex,amount){const n=parseInt(hex.replace('#',''),16),r=Math.max(0,Math.min(255,(n>>16)+amount)),g=Math.max(0,Math.min(255,((n>>8)&255)+amount)),b=Math.max(0,Math.min(255,(n&255)+amount));return `rgb(${r},${g},${b})`;}
function cube(x,z,width,depth,height,base,color){
  const points=[[-width/2,-depth/2],[width/2,-depth/2],[width/2,depth/2],[-width/2,depth/2]];
  const bottom=points.map(([a,b])=>project(x+a,z+b,base)),top=points.map(([a,b])=>project(x+a,z+b,base+height));
  const sides=points.map((_,i)=>({i,j:(i+1)%4,y:(bottom[i].y+bottom[(i+1)%4].y)/2})).sort((a,b)=>a.y-b.y);
  for(const {i,j}of sides)polygon([bottom[i],bottom[j],top[j],top[i]],brighten(color,i%2?-27:-15));
  polygon(top,color,'#634e3230');
}
function ellipse(x,z,rx,rz,color,y=.01){const p=project(x,z,y);ctx.fillStyle=color;ctx.beginPath();ctx.ellipse(p.x,p.y,rx*scale(),rz*scale()*.52,0,0,Math.PI*2);ctx.fill();}
function line3(points,color,width=1){ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();points.forEach(([x,z,y],i)=>{const p=project(x,z,y);i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)});ctx.stroke();}
function textAt(text,x,z,y,color='#fff4d4',size=11){const p=project(x,z,y);ctx.font=`500 ${size}px "Microsoft YaHei",system-ui`;ctx.textAlign='center';ctx.lineWidth=3;ctx.strokeStyle='#163b40';ctx.strokeText(text,p.x,p.y);ctx.fillStyle=color;ctx.fillText(text,p.x,p.y);}
function sprite(image,x,z,height,base=.2,flip=false){const p=project(x,z,base),hh=height*scale(),ww=hh*image.width/image.height;ctx.save();ctx.translate(p.x,p.y);if(flip)ctx.scale(-1,1);ctx.drawImage(image,-ww/2,-hh,ww,hh);ctx.restore();}
function drawWater(){
  const gradient=ctx.createRadialGradient(w*.5,h*.45,10,w*.5,h*.45,Math.max(w,h)*.7);gradient.addColorStop(0,'#267f83');gradient.addColorStop(1,'#123f55');ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);
  ctx.save();ctx.strokeStyle='#7bb5a217';ctx.lineWidth=1.5;const drift=time*6;for(let k=-h;k<w+h;k+=72){ctx.beginPath();for(let y=-60;y<h+60;y+=15){const x=k+y*.47+Math.sin(y*.017+time*.24)*20+drift%72;y===-60?ctx.moveTo(x,y):ctx.lineTo(x,y);}ctx.stroke();}
  ctx.strokeStyle='#a5d9c720';ctx.lineWidth=1;for(let n=0;n<40;n++){const x=((n*137.23+time*5)% (w+80))-40,y=((n*93.77)%(h+60))-30;ctx.beginPath();ctx.moveTo(x,y);ctx.quadraticCurveTo(x+10,y+3,x+24,y);ctx.stroke();}ctx.restore();
}
function drawTile(k){const[x,z]=cell(k).map(n=>n*TILE);ellipse(x+.15,z+.15,.8,.8,'#0c3b4233',-.12);cube(x,z,TILE*.99,TILE*.99,.21,-.03,'#af8756');for(let i=0;i<5;i++)cube(x,z+(i-2)*TILE/5,TILE*.98,TILE/5-.016,.045,.18,i%2?'#d6b67f':'#ddbe89');}
function drawBuilding(k,b){
  const[x,z]=cell(k).map(n=>n*TILE),turn=b.rotation*Math.PI/2;
  if(b.id==='shop'){
    cube(x,z,.96,.73,.64,.22,'#ded6b3');cube(x,z+.37,.92,.2,.15,.62,'#9d7655');
    for(let i=0;i<5;i++)cube(x+(i-2)*.23,z+.08,.225,1.05,.07,1.17,i%2?'#f7e8c1':'#dc8b71');
    for(const a of [-.48,.48])cube(x+a,z+.42,.045,.045,1.02,.2,'#6b614a');
  }else if(b.id==='workshop'){
    for(const a of[-.4,.4])for(const c of[-.24,.24])cube(x+a,z+c,.075,.075,.57,.2,'#7d6046');
    cube(x,z,1.05,.7,.12,.75,'#a77c4e');cube(x,z-.31,.92,.07,.62,.83,'#62857e');cube(x+.24,z,.25,.24,.13,.87,'#738e96');cube(x-.22,z+.08,.4,.07,.06,.89,'#d9b164');
  }else if(b.id==='warehouse'){
    cube(x,z,1.05,.92,.96,.21,'#abc2b7');cube(x,z,1.18,1.05,.18,1.17,'#5c7e7c');cube(x,z+.48,.5,.04,.64,.21,'#647e77');cube(x-.43,z+.55,.35,.35,.33,.21,'#b79763');
  }else if(b.id==='dock'){
    const c=Math.cos(turn),s=Math.sin(turn);for(const a of [-.48,.48]){const xx=x+a*c-.35*s,zz=z+a*s+.35*c;cube(xx,zz,.1,.1,.7,.2,'#d8bd89');cube(xx,zz,.16,.16,.06,.9,'#648b83');}
    line3([[x-.5*c,z-.5*s,.7],[x+.5*c,z+.5*s,.7]],'#ac8757',4);
    const p=project(x,z,.62);ctx.strokeStyle='#e5af65';ctx.lineWidth=3;ctx.beginPath();ctx.arc(p.x,p.y,scale()*.13,0,7);ctx.stroke();
  }
}
function spawnResource(){
  if(resources.length>=24)return;const raw=Object.values(game.items).filter(i=>i.kind==='resource'),id=raw[Math.floor(Math.random()*raw.length)].id;
  let extent=9;for(const k of game.tiles)extent=Math.max(extent,...cell(k).map(n=>Math.abs(n*TILE)+3.5));
  for(let tries=0;tries<45;tries++){const x=(Math.random()*2-1)*extent,z=(Math.random()*2-1)*extent;if(game.tiles.has(key(Math.round(x/TILE),Math.round(z/TILE)))||resources.some(r=>Math.hypot(r.x-x,r.z-z)<.8))continue;resources.push({id,x,z,amount:2,life:65+Math.random()*25,phase:Math.random()*6});return;}
}
function drawResource(r){
  const bob=Math.sin(time*1.5+r.phase)*.04;ellipse(r.x,r.z,.4,.28,'#a3d0ba25',-.02);
  if(r.id==='wood'){for(let i=0;i<3;i++)cube(r.x,r.z+(i-1)*.12,.65,.1,.1,bob,'#d6b77c');}
  else if(r.id==='scrap'){cube(r.x,r.z,.45,.3,.22,bob-.04,'#9bbabc');cube(r.x+.09,r.z,.055,.31,.23,bob-.04,'#567e83');}
  else{cube(r.x,r.z,.39,.36,.31,bob-.01,'#e3d3ab');cube(r.x,r.z,.4,.07,.025,bob+.3,'#9a855b');}
}
function drawBoat(boat){
  const{x,z,color}=boat;ellipse(x+.15,z+.2,.6,.95,'#0a3d4635',-.1);
  const hull=[[-.4,-.6],[-.28,.75],[0,.96],[.28,.75],[.4,-.6]].map(([a,b])=>project(x+a,z+b,.04));polygon(hull,'#846446');cube(x,z,.52,1.12,.055,.1,'#c5a36c');
  line3([[x,z-.2,.1],[x,z-.2,1.95]],'#e9d4a3',2.5);
  polygon([[x,z-.2,1.9],[x+.82,z-.2,1.7],[x+.72,z-.2,.83],[x,z-.2,.85]].map(p=>project(...p)), '#faf0d0');
  polygon([[x,z-.2,1],[x+.73,z-.2,.98],[x+.72,z-.2,.83],[x,z-.2,.85]].map(p=>project(...p)),`#${color}`);
  cube(x,z+.38,.16,.2,.33,.15,`#${color}`);const p=project(x,z+.38,.59);ctx.fillStyle='#d6b58b';ctx.beginPath();ctx.arc(p.x,p.y,scale()*.09,0,7);ctx.fill();
}
function drawVendor(){
  const k=game.reservedCell();if(!k)return;const[x,z]=cell(k).map(n=>n*TILE);
  ellipse(x,z,.55,.4,'#6f593850',.22);sprite(images.food_supplier,x,z,1.6,.24);
  cube(x,z+.23,1.05,.48,.42,.22,'#9a6a4e');cube(x,z+.23,1.12,.52,.06,.64,'#dec394');
  for(let n=0;n<3;n++){const p=project(x+(n-1)*.28,z+.23,.77);ctx.fillStyle='#f1e5bd';ctx.beginPath();ctx.ellipse(p.x,p.y,scale()*.12,scale()*.06,0,0,7);ctx.fill();ctx.fillStyle='#a56542';ctx.beginPath();ctx.ellipse(p.x,p.y-1,scale()*.085,scale()*.035,0,0,7);ctx.fill();}
  textAt('海岛食堂',x,z,1.94,'#ffdf9c',w<=860?9:11);
}
function drawPreview(){
  if(mode==='collect'||!hover||paused)return;const[x,z]=cell(hover).map(n=>n*TILE),valid=!game.placementError(mode,hover);const corners=[[-.69,-.69],[.69,-.69],[.69,.69],[-.69,.69]].map(([a,b])=>project(x+a,z+b,.26));
  ctx.save();ctx.globalAlpha=.56;polygon(corners,valid?'#8ed4ae':'#de836f','#fff0d8');if(mode!=='expand')drawBuilding(hover,{id:mode,rotation});ctx.restore();
}
function draw(){
  drawWater();
  if(game.atSea()){
    resources.slice().sort((a,b)=>project(a.x,a.z).y-project(b.x,b.z).y).forEach(drawResource);
    drawBoat({x:0,z:0,color:'e5b45f'});sprite(images.naiwa,0,.4,1.4,.3+Math.sin(time*2)*.04);textAt('奶娃 · 出海中',0,0,2.35,'#fff1c5',w<=860?11:13);return;
  }
  const tiles=[...game.tiles].sort((a,b)=>{const[x,z]=cell(a),[xx,zz]=cell(b);return project(x,z).y-project(xx,zz).y;});for(const k of tiles)drawTile(k);
  const entities=resources.map(r=>({depth:project(r.x,r.z).y,draw:()=>drawResource(r)}));
  for(const[k,b]of Object.entries(game.structures)){const[x,z]=cell(k).map(n=>n*TILE);entities.push({depth:project(x,z).y,draw:()=>drawBuilding(k,b)});}
  const vendor=game.reservedCell();if(vendor){const[x,z]=cell(vendor).map(n=>n*TILE);entities.push({depth:project(x,z+.2).y,draw:drawVendor});}
  entities.push({depth:project(hero.x,hero.z).y,draw:()=>{ellipse(hero.x,hero.z,.31,.23,'#8a704550',.235);sprite(images.naiwa,hero.x,hero.z,characters.hero.world_height,.24+Math.sin(time*(hero.path.length?11:2))*(hero.path.length?.06:.012),hero.flip);textAt('奶娃',hero.x,hero.z,2.25,'#fff2bf',w<=860?10:11);}});
  for(const boat of boats.values())entities.push({depth:project(boat.x,boat.z).y,draw:()=>drawBoat(boat)});
  entities.sort((a,b)=>a.depth-b.depth);entities.forEach(e=>e.draw());drawPreview();
  // One simple pennant identifies the home island from a distance.
  line3([[-2.67,-2.67,.23],[-2.67,-2.67,1.8]],'#e4cd94',2.5);polygon([project(-2.67,-2.67,1.8),project(-2,-2.67,1.63),project(-2.67,-2.67,1.48)],'#e9b45f');
}
function update(dt){
  time+=dt;game.syncClock();if(paused)return;game.tick(dt);spawnClock+=dt;saveClock+=dt;
  if(spawnClock>=game.settings.floating_interval_seconds){spawnClock=0;if(game.atSea())spawnResource();}if(saveClock>=20){saveClock=0;save();}
  for(const r of resources){r.life-=dt;r.x+=dt*.035;}resources=resources.filter(r=>r.life>0&&!game.tiles.has(key(Math.round(r.x/TILE),Math.round(r.z/TILE))));
  const active=new Set();for(const v of game.visitors){active.add(v.slot);let b=boats.get(v.slot);if(!b){b={x:-4.6+v.slot*4.6,z:16,color:game.npcs[v.npc].color};boats.set(v.slot,b);}b.x=-4.6+v.slot*4.6;b.z=(v.slot===1?4.5:1.6)+Math.max(0,1-v.age/2)*13;}
  for(const[slot,b]of boats)if(!active.has(slot)){b.z+=dt*3.5;if(b.z>17)boats.delete(slot);}
  if(hero.path.length){const k=hero.path[0],[x,z]=cell(k).map(n=>n*TILE),dx=x-hero.x,dz=z-hero.z,d=Math.hypot(dx,dz),step=dt*2.8;hero.flip=project(x,z).x>project(hero.x,hero.z).x;if(d<=step){hero.x=x;hero.z=z;hero.cell=k;hero.path.shift();}else{hero.x+=dx/d*step;hero.z+=dz/d*step;}}
  if(keys.has('KeyQ'))yaw-=dt;if(keys.has('KeyE'))yaw+=dt;
  const dx=Number(keys.has('KeyD'))-Number(keys.has('KeyA')),dz=Number(keys.has('KeyS'))-Number(keys.has('KeyW'));pan.x=Math.max(-12,Math.min(12,pan.x+(dx*Math.cos(yaw)+dz*Math.sin(yaw))*dt*5));pan.z=Math.max(-12,Math.min(12,pan.z+(-dx*Math.sin(yaw)+dz*Math.cos(yaw))*dt*5));
}
function resourceAt(x,y){let found=null,distance=Math.max(20,scale()*.48);for(const r of resources){const p=project(r.x,r.z,.14),d=Math.hypot(p.x-x,p.y-y);if(d<distance){found=r;distance=d;}}return found;}
function clickWorld(x,y){
  if(paused)return;
  if(game.atSea()){const r=resourceAt(x,y);if(r){const n=game.collect(r.id,r.amount);if(n){r.amount-=n;if(!r.amount)resources.splice(resources.indexOf(r),1);notify(`奶娃打捞到 ${game.items[r.id].name} +${n}`);}}return;}
  const vendor=game.reservedCell();if(vendor){const[a,b]=cell(vendor).map(n=>n*TILE),p=project(a,b,.8);if(Math.hypot(x-p.x,y-p.y)<Math.max(24,scale()*.75)){openDialog('#food-dialog');return;}}
  const r=resourceAt(x,y);if(r){const n=game.collect(r.id,r.amount);if(n){r.amount-=n;if(!r.amount)resources.splice(resources.indexOf(r),1);notify(`奶娃打捞到 ${game.items[r.id].name} +${n}`);}return;}
  const p=unproject(x,y),k=key(Math.round(p.x/TILE),Math.round(p.z/TILE));
  if(mode!=='collect'){const error=game.build(mode,k,rotation);notify(error||(mode==='expand'?'平台已扩建':`${game.buildings[mode].name}已建好`));return;}
  for(const[slot,b]of boats){const p=project(b.x,b.z,.3);if(Math.hypot(x-p.x,y-p.y)<Math.max(22,scale()*.5)){const error=game.trade(slot);if(error)notify(error);return;}}
  pathTo(k);
}
function bindInput(){
  addEventListener('resize',resize);canvas.addEventListener('contextmenu',e=>{e.preventDefault();selectMode('collect');});
  canvas.addEventListener('pointerdown',e=>{if(e.button!==0&&e.button!==1)return;drag={x:e.clientX,y:e.clientY,pan:{...pan},button:e.button};dragged=false;canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{pointer={x:e.clientX,y:e.clientY};const p=unproject(pointer.x,pointer.y);hover=key(Math.round(p.x/TILE),Math.round(p.z/TILE));if(drag&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>8){dragged=true;const a=unproject(drag.x,drag.y),b=unproject(e.clientX,e.clientY);pan.x+=a.x-b.x;pan.z+=a.z-b.z;drag.x=e.clientX;drag.y=e.clientY;}canvas.style.cursor=mode!=='collect'?'crosshair':resourceAt(pointer.x,pointer.y)?'pointer':'default';updateHint();});
  canvas.addEventListener('pointerup',e=>{if(drag&&!dragged&&e.button===0)clickWorld(e.clientX,e.clientY);drag=null;});canvas.addEventListener('pointercancel',()=>drag=null);
  canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(32,Math.min(82,zoom-e.deltaY*.03));},{passive:false});
  addEventListener('keydown',e=>{if(['Space','ArrowUp','ArrowDown'].includes(e.code))e.preventDefault();if(e.target.closest('button,dialog,input'))return;if($('#food-dialog').open||$('#new-dialog').open)return;if(e.code==='Escape'){selectMode('collect');setSheet('none');}if(e.code==='Space'&&!e.repeat){paused=!paused;render();}if(e.code==='KeyR')rotation=(rotation+1)%4;if(e.code==='KeyF'){pan={x:0,z:0};yaw=.65;}if(e.code==='F5'){e.preventDefault();save(true);}keys.add(e.code);});addEventListener('keyup',e=>keys.delete(e.code));addEventListener('blur',()=>keys.clear());
  document.addEventListener('visibilitychange',()=>{keys.clear();if(document.hidden)save();lastFrame=0;});addEventListener('pagehide',()=>save());
}
function frame(now){const dt=lastFrame?Math.min((now-lastFrame)/1000,.1):0;lastFrame=now;if(!document.hidden){update(dt);draw();uiClock+=dt;if(uiClock>.15){uiClock=0;renderRecipes();renderVisitors();renderJourney();if($('#food-dialog').open)renderVendor();}}requestAnimationFrame(frame);}
async function start(){
  try{
    const [catalog,defs]=await Promise.all(['./data/catalog.json','./data/characters.json'].map(async path=>{const r=await fetch(path);if(!r.ok)throw Error('配置加载失败');return r.json();}));characters=defs;game=new Economy(catalog);
    const sources=[defs.hero,...defs.guides,...defs.suppliers];await Promise.all(sources.map(row=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{images[row.id]=image;resolve();};image.onerror=()=>reject(Error(`角色图片无法加载：${row.name}`));image.src=row.image;})));
    try{const saved=localStorage.getItem(STORE);if(saved){const error=game.restore(JSON.parse(saved));if(error){saveBlocked=true;setTimeout(()=>notify(error),1000);}}}catch{saveBlocked=true;setTimeout(()=>notify('本地存档不可用；仍可试玩。需要时可下载存档。'),1000);}
    setupUI();started=true;game.onChange=render;game.onNotice=notify;render();resize();bindInput();$('#hud').hidden=false;$('#loading').style.opacity=0;setTimeout(()=>$('#loading').remove(),350);requestAnimationFrame(frame);
  }catch(error){$('#loading-message').textContent=`${error.message}，请刷新重试。`;console.error(error);}
}
start();
