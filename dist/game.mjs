import {Economy,key,cell,directions} from './economy.mjs';

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STORE='tideline-naiwa-v1', TILE=1.42;
const canvas=$('#sea'),ctx=canvas.getContext('2d');
let game,characters,images={},mode='collect',rotation=0,paused=false,selectedGuide='renbo',lastStage='',saveBlocked=false,decorateSelection=null;
let w=0,h=0,dpr=1,zoom=53,yaw=.65,pan={x:0,z:0},hero={x:0,z:0,cell:'0,0',path:[],flip:false},pointer={x:-999,y:-999},hover=null;
let time=0,lastFrame=0,uiClock=0,spawnClock=0,saveClock=0,toastTimer,resources=[],boats=new Map(),keys=new Set(),dialogPreviousPause=false;
let storageWorks=true,started=false,drag=null,dragged=false;
let lastVoyage=false;

const costText=cost=>Object.entries(cost).map(([id,n])=>`${game.items[id].name} ${n}`).join(' · ');
function notify(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),3300);}
function stage(){return !game.has('workshop')?'start':!game.trades?'craft':game.reputation<3?'trade':'grow';}
function setGuide(id){selectedGuide=id;renderGuide();}
function renderGuide(){
  const bar=$('#guide-bar');if(game.atSea()){bar.hidden=true;return;}bar.hidden=false;
  const unlocked=game.introComplete();$$('[data-guide]').forEach(button=>button.hidden=unlocked);
  for(const id of ['renbo','chaorui']){
    const button=$(`#${id}-task-open`);button.hidden=false;button.classList.toggle('locked',!unlocked);button.setAttribute('aria-disabled',String(!unlocked));
    if(!unlocked)button.textContent=`${id==='renbo'?'仁博 · 出海任务':'晁瑞 · 建造任务'}（未解锁）`;
  }
  if(unlocked){const guide=characters.guides[0],renboReady=game.questBoard('renbo').tasks.filter(task=>game.questComplete(task)).length,chaoruiReady=game.questBoard('chaorui').tasks.filter(task=>game.questComplete(task)).length;$('#guide-image').src=guide.image;$('#guide-image').alt=guide.name;$('#guide-name').textContent='任务铺已营业';$('#guide-line').textContent=`仁博负责出海任务，晁瑞负责建造任务。可领取奖励：仁博 ${renboReady} 个 · 晁瑞 ${chaoruiReady} 个。`;return;}
  const current=stage();if(current!==lastStage){selectedGuide=current==='start'?'renbo':'chaorui';lastStage=current;}
  const guide=characters.guides.find(g=>g.id===selectedGuide);$('#guide-image').src=guide.image;$('#guide-image').alt=guide.name;
  $('#guide-name').textContent=`${guide.name} / ${guide.role}`;$('#guide-line').textContent=guide.lines[current];
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
  $('#capacity').textContent=`原料仓 ${game.rawTotal()} / ${game.capacity()} · 浮岛 ${game.tiles.size} 格`+(game.construction?`\n便正在扩建 · ${Math.ceil(game.construction.remaining)} 秒`:'\n便 · 负责浮岛扩建');
  updateHint();
}
function renderVisitors(){
  const capacity=game.orderCapacity(),container=$('#visitors');
  if(container.children.length!==capacity){container.innerHTML=Array.from({length:capacity},(_,slot)=>`<article class="visitor" data-slot="${slot}"><div class="visitor-heading"><h3>空闲泊位</h3><small></small></div><p class="order"></p><button class="primary">等待到港</button></article>`).join('');$$('[data-slot] button').forEach(b=>b.onclick=()=>{if(!paused){const error=game.trade(Number(b.closest('[data-slot]').dataset.slot));if(error)notify(error);}});}
  $('#order-count').textContent=`${game.visitors.length} / ${capacity}`;
  $('#mobile-order-count').textContent=game.visitors.length;
  for(let slot=0;slot<capacity;slot++){
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
  $('#food-wallet').textContent=`奶蛙的金币：${game.coins}　·　食堂营业中`;
  if(game.atSea())$('#food-wallet').textContent=`出海途中 · 体力 ${game.stamina} / ${game.settings.max_stamina}`;
  const eatError=game.eatError();$('#eat-food').disabled=Boolean(eatError);$('#eat-food').textContent=eatError||`吃一份猪脚饭 · 体力 +${game.settings.food_stamina_restore}`;
  $('#food-count').textContent=game.count('pork_rice');
  vendor.offers.forEach((offer,i)=>{const card=$(`[data-offer="${i}"]`),error=game.purchaseError(vendor.id,i);card.querySelector('.food-owned').textContent=`背包已有 ${game.count(offer.item)} 份`;const b=card.querySelector('button');b.disabled=Boolean(error);b.textContent=error||`购买 ${offer.quantity} 份 · ${offer.price} 金币`;});
}
function renderRecruitment(){
  const config=game.settings.employees.zihao,count=game.employeeCount('zihao'),working=game.employeeWorkingCount('zihao'),error=game.hireEmployeeError('zihao');
  $('#zihao-status').textContent=`已招募 ${count} / ${config.max} · 工作中 ${working} · 停工 ${count-working}`;
  $('#zihao-timer').textContent=count?(working?`下一艘船 ${formatClock(game.employeeSecondsRemaining('zihao'))} 后返航`:'缺少猪脚饭，船队已停工'):'尚未组建船队';
  const maker=game.settings.employees.haozi,makerCount=game.employeeCount('haozi'),makerWorking=game.employeeWorkingCount('haozi'),makerError=game.hireEmployeeError('haozi'),busy=game.employeeJobs.haozi.filter(Boolean).length;
  $('#haozi-status').textContent=`已招募 ${makerCount} / ${maker.max} · 工作中 ${makerWorking} · 停工 ${makerCount-makerWorking}`;
  $('#haozi-timer').textContent=makerCount?(makerWorking?`正在加工 ${busy} 单 · 等待材料或订单 ${makerWorking-busy} 人`:'缺少猪脚饭，自动加工已停止'):'尚未安排自动加工';
  $('#recruit-wallet').textContent=`奶蛙的金币：${game.coins}`;
  const button=$('#hire-zihao');button.disabled=Boolean(error);button.textContent=error||`招募自豪 · ${config.price} 金币`;
  const makerButton=$('#hire-haozi');makerButton.disabled=Boolean(makerError);makerButton.textContent=makerError||`招募豪自 · ${maker.price} 金币`;
  const total=count+makerCount,active=working+makerWorking,mealTimes=['zihao','haozi'].map(id=>game.employeeMealSecondsRemaining(id)).filter(Boolean);$('#employee-meal-status').textContent=total?`员工口粮：猪脚饭 ${game.count('pork_rice')} 份 · 工作 ${active}/${total}${mealTimes.length?` · 下一次用餐 ${formatClock(Math.min(...mealTimes))}`:''}`:'尚未招募员工；招募后前 20 分钟无需消耗口粮。';
}
function renderQuestBoard(id){
  const board=game.questBoard(id),container=$(`#${id}-quests`),owner=id==='renbo'?'仁博':'晁瑞';
  if(!game.introComplete()){container.innerHTML='<div class="quest-empty">完成开场任务后解锁</div>';return;}
  container.innerHTML=board.tasks.length?board.tasks.map(task=>{const progress=game.questProgress(task),ready=game.questComplete(task);return `<article class="quest-card${ready?' ready':''}" data-quest="${escape(task.id)}"><div class="quest-card-head"><strong>${escape(task.name)}</strong><span>${progress} / ${task.goal} ${escape(task.unit)}</span></div><p>${ready?'任务已完成，回店交接即可抽取奖励。':'任务领取后开始计数，完成进度会自动保存。'}</p><div class="progress"><i style="width:${progress/task.goal*100}%"></i></div><button class="primary" ${ready&&!game.atSea()?'':'disabled'}>${ready?'领取随机奖励':'进行中'}</button></article>`;}).join(''):'<div class="quest-empty">本轮任务已全部完成<br><small>下次刷新时补充新任务</small></div>';
  const ready=board.tasks.filter(task=>game.questComplete(task)).length;$(`#${id}-task-open`).textContent=`${owner} · ${id==='renbo'?'出海':'建造'}任务${ready?` (${ready})`:''}`;
  $(`#${id}-refresh`).textContent=`距离补充任务 ${formatClock(game.questRefreshSeconds(id))} · 当前 ${board.tasks.length} / ${game.settings.quests.max_per_board}`;
}
function renderQuestBoards(){renderQuestBoard('renbo');renderQuestBoard('chaorui');}
function render(){
  if(!started)return;
  const atSea=game.atSea();if(atSea!==lastVoyage){lastVoyage=atSea;resources=[];spawnClock=0;pan={x:0,z:0};hero.path=[];if(atSea)spawnResource();}
  for(const id of Object.keys(game.items)){$(`[data-count="${id}"]`)?.replaceChildren(document.createTextNode(game.count(id)));}
  $('[data-count="coins"]').textContent=game.coins;$('[data-count="reputation"]').textContent=String(game.reputation).padStart(2,'0');
  $('#pause').textContent=paused?'继续':'暂停';$('#decorate-toggle').textContent=mode==='decorate'?'退出装修':'装修';$('#decorate-toggle').classList.toggle('active',mode==='decorate');renderGuide();renderRecipes();renderVisitors();renderVendor();renderRecruitment();renderQuestBoards();
  renderJourney();renderCompanion();renderDorm();updateHint();
  if(game.structures[hero.cell]||game.landmarkAt(hero.cell)){hero.cell=[...game.tiles].find(k=>!game.structures[k]&&!game.landmarkAt(k))||hero.cell;[hero.x,hero.z]=cell(hero.cell).map(n=>n*TILE);hero.path=[];}
}
function selectMode(id){if(game.atSea()&&id!=='collect'){notify('返航后才能调整浮岛');return;}mode=id;if(id!=='decorate')decorateSelection=null;$$('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===id));const decorate=$('#decorate-toggle');if(decorate){decorate.textContent=id==='decorate'?'退出装修':'装修';decorate.classList.toggle('active',id==='decorate');}setSheet('none');updateHint();}
function renderJourney(){
  $('#stamina-count').textContent=`体力 ${game.stamina} / ${game.settings.max_stamina}`;
  const wait=Math.max(0,Math.ceil((game.settings.stamina_regen_seconds*1000-(Date.now()-game.staminaAt))/1000));
  $('#stamina-recovery').textContent=game.stamina===game.settings.max_stamina?'每小时回复 1 点':`${Math.floor(wait/60)}:${String(wait%60).padStart(2,'0')} 后回复 1 点`;
  const b=$('#voyage-button'),left=Math.max(0,Math.ceil((game.voyageUntil-Date.now())/1000));b.textContent=game.atSea()?`返航 · 剩余 ${left} 秒`:'出海 · 消耗 1 体力';b.disabled=paused||(!game.atSea()&&game.stamina<game.settings.voyage_stamina_cost);
  const salvage=$('#salvage-button'),error=game.salvageError();salvage.hidden=!game.atSea();salvage.textContent=error||'随机打捞';salvage.disabled=paused||Boolean(error);
}
function renderCompanion(){
  const c=game.companion,b=game.companionBonuses(),max=c.level===game.settings.companion.max_level,needed=game.companionXpNeeded();
  const state=c.equipped?'同行':game.housing.dorm?'住宿':'休息';
  $('#companion-summary').textContent=`樾 · Lv.${c.level} · ${state}`;
  $('#companion-desktop').textContent=`樾 Lv.${c.level} · ${state}`;
  $('#companion-brief').textContent=c.equipped?`数量 +${b.quantity}% · 精良 ${b.fine}% · 稀有 ${b.rare}%`:game.housing.dorm?'正在宿舍缓慢成长 · 离线有效':'出战提升打捞，住宿则自动成长';
  $('#companion-level').textContent=`Lv.${c.level}`;
  $('#companion-status').textContent=game.atSea()?(c.equipped?'樾正在陪同奶蛙出海。返航后可调整。':game.housing.dorm?'樾留在宿舍成长，奶蛙本次独自出海。':'樾在岛上休息，返航后可邀请同行。'):(c.equipped?'已准备同行，下次出海自动陪同奶蛙。':game.housing.dorm?'樾已入住宿舍，离线期间也会继续成长。':'正在岛上休息，可选择出战或入住宿舍。');
  $('#companion-bonus').textContent=`平均打捞数量 +${b.quantity}%`;
  $('#companion-quality').textContent=`精良概率 ${b.fine}% · 稀有概率 ${b.rare}%`;
  $('#companion-xp').textContent=max?'已满级':`经验 ${c.xp} / ${needed} · 还需 ${needed-c.xp} 次成功打捞升级`;
  $('#companion-xp-bar').style.width=max?'100%':`${c.xp/needed*100}%`;
  const button=$('#companion-toggle');button.disabled=game.atSea();button.textContent=game.atSea()?'返航后调整':c.equipped?'让樾休息':'邀请樾出战';
  $('#companion-dorm').disabled=game.atSea();
}
function formatClock(seconds){return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
function renderDorm(){
  const rooms=game.dormitories(),empty=$('#dorm-empty'),body=$('#dorm-rooms'),select=$('#dorm-room'),previous=select.value;
  empty.hidden=rooms.length>0;body.hidden=!rooms.length;
  if(!rooms.length)return;
  select.innerHTML=rooms.map((k,i)=>`<option value="${escape(k)}">宿舍 ${i+1} · 平台 ${escape(k)}</option>`).join('');
  select.value=rooms.includes(previous)?previous:(game.housing.dorm||rooms[0]);
  const housed=Boolean(game.housing.dorm),here=game.housing.dorm===select.value,max=game.companion.level===game.settings.companion.max_level;
  $('#dorm-yue-name').textContent=`樾 · Lv.${game.companion.level} · ${here?'已入住':housed?'住在其他宿舍':'等待入住'}`;
  $('#dorm-yue-progress').textContent=max?'已满级':here?`下一点经验 ${formatClock(game.housingSecondsRemaining())}`:'入住后每 30 分钟获得 1 点经验';
  const action=$('#dorm-action');action.disabled=game.atSea();action.textContent=game.atSea()?'返航后调整':here?'让樾退宿休息':housed?'搬到这栋宿舍':'安置樾';
  $('#dorm-note').textContent=here?'离开页面也会按真实时间累计；邀请出海会自动退宿。':'入住会取消樾的出战状态，已积累的不足 30 分钟进度会保留。';
}
function updateHint(){
  if(game.construction&&!game.atSea()){$('#mode-hint').textContent=`便正在扩建 · 还需 ${Math.ceil(game.construction.remaining)} 秒`;return;}
  if(game.atSea()){$('#mode-hint').textContent='随机打捞为主 · 海面偶遇物资可直接拾取';return;}
  if(mode==='decorate'){$('#mode-hint').textContent=decorateSelection?`已选择${decorateSelection.name} · 点击目标平台完成移动`:'装修模式 · 点击建筑或地标，再点击目标平台';return;}
  $('#mode-hint').textContent=mode==='collect'?'小岛上无法打捞 · 点击出海，或吃饭补充体力':hover?game.placementError(mode,hover)||(mode==='expand'?'点击扩建平台':`点击建造${game.buildings[mode].name} · R 旋转`):'点击空平台放置，右键取消';
}
function renderSideControls(){const hidden=$$('.side').filter(panel=>panel.classList.contains('collapsed')).length;$('#panels-toggle').textContent=hidden?'显示侧栏':'隐藏侧栏';}
function setSheet(name){if(name==='craft')$('#craft-panel').classList.remove('collapsed');if(name==='orders')$('#orders-panel').classList.remove('collapsed');$('#craft-panel').classList.toggle('active',name==='craft');$('#orders-panel').classList.toggle('active',name==='orders');$$('[data-sheet]').forEach(b=>b.classList.toggle('active',b.dataset.sheet===name));renderSideControls();}
function toggleSidePanels(){const panels=$$('.side'),hide=panels.every(panel=>!panel.classList.contains('collapsed'));panels.forEach(panel=>panel.classList.toggle('collapsed',hide));setSheet('none');renderSideControls();}
function openDialog(id){
  if($$('dialog').some(d=>d.open))return;dialogPreviousPause=paused;paused=true;render();$(id).showModal();keys.clear();
}
function closeDialog(id){$(id).close();paused=dialogPreviousPause;render();}
function save(manual=false){
  if(saveBlocked){if(manual)notify('原存档无法读取。先下载备份，再通过「新局」确认重置。');return;}
  try{const previous=localStorage.getItem(STORE);if(previous)localStorage.setItem(`${STORE}-backup`,previous);localStorage.setItem(STORE,JSON.stringify(game.snapshot()));storageWorks=true;$('#save-status').textContent='已保存到当前浏览器';if(manual)notify('进度已保存');}
  catch{storageWorks=false;$('#save-status').textContent='存储不可用，请下载存档';if(manual)notify('浏览器禁止本地存储，可通过新局窗口下载存档。');}
}
function pathTo(goal){
  if(!game.tiles.has(goal)||game.structures[goal]||game.landmarkAt(goal))return;
  const parents=new Map([[hero.cell,null]]),front=[hero.cell];for(let i=0;i<front.length&&!parents.has(goal);i++){const[x,z]=cell(front[i]);for(const[dx,dz]of directions){const next=key(x+dx,z+dz);if(!game.tiles.has(next)||game.structures[next]||game.landmarkAt(next)||parents.has(next))continue;parents.set(next,front[i]);front.push(next);}}
  if(!parents.has(goal))return;hero.path=[];for(let p=goal;p!==hero.cell;p=parents.get(p))hero.path.unshift(p);
}
function setupUI(){
  $('#resources').innerHTML=Object.values(game.items).filter(i=>i.kind==='resource'&&!i.hide_topbar).map(i=>`<div class="resource"><small>${escape(i.name)}</small><strong data-count="${escape(i.id)}">0</strong></div>`).join('')+'<div class="resource gold"><small>金币</small><strong data-count="coins">80</strong></div><div class="resource rep"><small>声望</small><strong data-count="reputation">00</strong></div>';
  $('#recipes').innerHTML=Object.values(game.recipes).map(r=>`<article class="recipe" data-recipe="${escape(r.id)}"><div class="recipe-heading"><h3>${escape(game.items[r.output].name)}</h3><span class="owned">×0</span></div><p class="cost">${escape(costText(r.cost))}</p><button class="primary">制作</button><div class="progress"><i></i></div></article>`).join('');
  for(const r of Object.values(game.recipes))$(`[data-recipe="${r.id}"] button`).onclick=()=>{if(paused)return;const error=game.craft(r.id);notify(error||'已加入制作队列');};
  const entries=[{id:'collect',name:'航行打捞',detail:'出海后收集物资'},{id:'expand',name:'扩建平台',detail:costText(game.settings.expansion_cost)},...Object.values(game.buildings).map(b=>({id:b.id,name:b.name,detail:`${costText(b.cost)} · ${b.coins} 金`}))];
  $('#build-tools').innerHTML=entries.map(b=>`<button data-mode="${b.id}" class="${b.id===mode?'active':''}">${escape(b.name)}<span>${escape(b.detail)}</span></button>`).join('');
  $$('[data-mode]').forEach(b=>b.onclick=()=>selectMode(b.dataset.mode));
  $('#decorate-toggle').onclick=()=>selectMode(mode==='decorate'?'collect':'decorate');
  $('#panels-toggle').onclick=toggleSidePanels;
  $$('[data-panel-close]').forEach(button=>button.onclick=()=>{const id=button.dataset.panelClose;document.querySelector(`#${id==='craft'?'craft':'orders'}-panel`).classList.add('collapsed');setSheet('none');renderSideControls();});
  $$('[data-guide]').forEach(b=>b.onclick=()=>setGuide(b.dataset.guide));
  $$('[data-sheet]').forEach(b=>b.onclick=()=>{const panel=b.dataset.sheet;const active=panel!=='none'&&$(`#${panel==='craft'?'craft':'orders'}-panel`).classList.contains('active');setSheet(active?'none':panel);});
  const offers=game.vendors.food_supplier.offers;
  $('#food-offers').innerHTML=offers.map((o,i)=>`<article class="food-offer" data-offer="${i}"><div class="food-offer-heading"><strong>${escape(game.items[o.item].name)}</strong><span>${o.price} 金币 / 份</span></div><p class="food-owned"></p><button class="primary">购买</button></article>`).join('');
  $$('[data-offer] button').forEach(b=>b.onclick=()=>{const error=game.buy('food_supplier',Number(b.closest('[data-offer]').dataset.offer));if(error)notify(error);else{renderVendor();save();}});
  $('#food-open').onclick=$('#food-mobile').onclick=()=>{setSheet('none');openDialog('#food-dialog');};
  $('#food-close').onclick=()=>closeDialog('#food-dialog');
  $('#recruit-desktop').onclick=()=>{setSheet('none');openDialog('#recruit-dialog');};
  $('#recruit-close').onclick=()=>closeDialog('#recruit-dialog');
  $('#hire-zihao').onclick=()=>{const error=game.hireEmployee('zihao');if(error)notify(error);else{renderRecruitment();save();}};
  $('#hire-haozi').onclick=()=>{const error=game.hireEmployee('haozi');if(error)notify(error);else{renderRecruitment();save();}};
  for(const id of ['renbo','chaorui']){
    $(`#${id}-task-open`).onclick=()=>{if(!game.introComplete()){notify('完成开场任务后解锁：建造加工台、完成 1 次交易并达到 3 点声望');return;}setSheet('none');openDialog(`#${id}-task-dialog`);};
    $(`#${id}-task-close`).onclick=()=>closeDialog(`#${id}-task-dialog`);
    $(`#${id}-quests`).onclick=event=>{const card=event.target.closest('[data-quest]');if(!card||!event.target.closest('button'))return;const result=game.claimQuest(id,card.dataset.quest);if(result.error)notify(result.error);else{renderQuestBoards();save();}};
  }
  $('#companion-open').onclick=()=>{setSheet('none');openDialog('#companion-dialog');};
  $('#companion-desktop').onclick=$('#companion-open').onclick;
  $('#companion-close').onclick=()=>closeDialog('#companion-dialog');
  $('#companion-toggle').onclick=()=>{const error=game.setCompanion(!game.companion.equipped);if(error)notify(error);else save();};
  $('#companion-dorm').onclick=()=>{closeDialog('#companion-dialog');openDialog('#dorm-dialog');};
  $('#dorm-mobile').onclick=()=>{setSheet('none');openDialog('#dorm-dialog');};
  $('#dorm-close').onclick=()=>closeDialog('#dorm-dialog');
  $('#dorm-build').onclick=()=>{closeDialog('#dorm-dialog');selectMode('dormitory');notify('选择一个空平台建造宿舍');};
  $('#dorm-room').onchange=renderDorm;
  $('#dorm-action').onclick=()=>{const error=game.housing.dorm===$('#dorm-room').value?game.unhouseCompanion():game.houseCompanion($('#dorm-room').value);if(error)notify(error);else save();};
  $('#eat-food').onclick=()=>{const error=game.eatFood();if(error)notify(error);else save();};
  $('#voyage-button').onclick=()=>{if(paused)return;if(game.atSea()){game.returnHome();}else{mode='collect';selectMode('collect');const error=game.beginVoyage();notify(error||'奶蛙出海了！体力 -1，本次航行 60 秒');}save();};
  $('#salvage-button').onclick=()=>{if(paused)return;const level=game.companion.level,result=game.salvage();notify(result.error||`随机打捞：${game.items[result.item].name} +${result.amount}${game.companion.level>level?` · 樾升到 Lv.${game.companion.level}！`:''}`);if(!result.error)save();};
  $('#pause').onclick=()=>{paused=!paused;render();};$('#save').onclick=()=>save(true);$('#new').onclick=()=>openDialog('#new-dialog');$('#cancel-new').onclick=()=>closeDialog('#new-dialog');
  $('#confirm-new').onclick=()=>{game.reset();hero={x:0,z:0,cell:'0,0',path:[],flip:false};saveBlocked=false;resources=[];boats.clear();for(let i=0;i<19;i++)spawnResource();lastStage='';pan={x:0,z:0};mode='collect';dialogPreviousPause=false;closeDialog('#new-dialog');selectMode('collect');save();notify('奶蛙的新航程开始了');};
  $('#backup').onclick=()=>{let data;try{data=saveBlocked?localStorage.getItem(STORE):JSON.stringify(game.snapshot(),null,2);}catch{}const url=URL.createObjectURL(new Blob([data||JSON.stringify(game.snapshot(),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='潮汐集市-存档.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  for(const id of ['#food-dialog','#recruit-dialog','#renbo-task-dialog','#chaorui-task-dialog','#new-dialog','#companion-dialog','#dorm-dialog'])$(id).addEventListener('cancel',event=>{event.preventDefault();closeDialog(id);});
}

function resize(){w=innerWidth;h=innerHeight;dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);}
function scale(){return zoom*(w<=860?Math.min(1,w/690):Math.min(1,w/1340));}
function worldY(){return h*(game.atSea()?(w<=860?.6:.57):(w<=860?.53:.51));}
function project(x,z,y=0){const dx=x-pan.x,dz=z-pan.z,s=scale(),c=Math.cos(yaw),sn=Math.sin(yaw);return {x:w*.5+(dx*c-dz*sn)*s,y:worldY()+(dx*sn+dz*c)*s*.52-y*s};}
function unproject(px,py){const s=scale(),a=(px-w*.5)/s,b=(py-worldY())/(s*.52),c=Math.cos(yaw),sn=Math.sin(yaw);return {x:a*c+b*sn+pan.x,z:-a*sn+b*c+pan.z};}
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
function sprite(image,x,z,height,base=.2,flip=false){if(!image)return;const p=project(x,z,base),hh=height*scale(),ww=hh*image.width/image.height;ctx.save();ctx.translate(p.x,p.y);if(flip)ctx.scale(-1,1);ctx.drawImage(image,-ww/2,-hh,ww,hh);ctx.restore();}
function drawWater(){
  const gradient=ctx.createRadialGradient(w*.5,h*.45,10,w*.5,h*.45,Math.max(w,h)*.7);gradient.addColorStop(0,'#267f83');gradient.addColorStop(1,'#123f55');ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);
  ctx.save();ctx.strokeStyle='#7bb5a217';ctx.lineWidth=1.5;const drift=time*6;for(let k=-h;k<w+h;k+=72){ctx.beginPath();for(let y=-60;y<h+60;y+=15){const x=k+y*.47+Math.sin(y*.017+time*.24)*20+drift%72;y===-60?ctx.moveTo(x,y):ctx.lineTo(x,y);}ctx.stroke();}
  ctx.strokeStyle='#a5d9c720';ctx.lineWidth=1;for(let n=0;n<40;n++){const x=((n*137.23+time*5)% (w+80))-40,y=((n*93.77)%(h+60))-30;ctx.beginPath();ctx.moveTo(x,y);ctx.quadraticCurveTo(x+10,y+3,x+24,y);ctx.stroke();}ctx.restore();
}
function drawTile(k){const[x,z]=cell(k).map(n=>n*TILE);ellipse(x+.15,z+.15,.8,.8,'#0c3b4233',-.12);cube(x,z,TILE*.99,TILE*.99,.21,-.03,'#af8756');for(let i=0;i<5;i++)cube(x,z+(i-2)*TILE/5,TILE*.98,TILE/5-.016,.045,.18,i%2?'#d6b67f':'#ddbe89');}
function drawBuilding(k,b){
  const[x,z]=cell(k).map(n=>n*TILE),turn=b.rotation*Math.PI/2;
  if(b.id==='workshop'){
    for(const a of[-.4,.4])for(const c of[-.24,.24])cube(x+a,z+c,.075,.075,.57,.2,'#7d6046');
    cube(x,z,1.05,.7,.12,.75,'#a77c4e');cube(x,z-.31,.92,.07,.62,.83,'#62857e');cube(x+.24,z,.25,.24,.13,.87,'#738e96');cube(x-.22,z+.08,.4,.07,.06,.89,'#d9b164');
  }else if(b.id==='warehouse'){
    cube(x,z,1.05,.92,.96,.21,'#abc2b7');cube(x,z,1.18,1.05,.18,1.17,'#5c7e7c');cube(x,z+.48,.5,.04,.64,.21,'#647e77');cube(x-.43,z+.55,.35,.35,.33,.21,'#b79763');
  }else if(b.id==='dock'){
    const c=Math.cos(turn),s=Math.sin(turn);for(const a of [-.48,.48]){const xx=x+a*c-.35*s,zz=z+a*s+.35*c;cube(xx,zz,.1,.1,.7,.2,'#d8bd89');cube(xx,zz,.16,.16,.06,.9,'#648b83');}
    line3([[x-.5*c,z-.5*s,.7],[x+.5*c,z+.5*s,.7]],'#ac8757',4);
    const p=project(x,z,.62);ctx.strokeStyle='#e5af65';ctx.lineWidth=3;ctx.beginPath();ctx.arc(p.x,p.y,scale()*.13,0,7);ctx.stroke();
  }else if(b.id==='dormitory'){
    cube(x,z,1.08,.88,.72,.21,'#a8b8d8');cube(x,z-.02,1.23,1.02,.18,.91,'#667ca3');
    cube(x,z+.46,.34,.035,.48,.22,'#efe4c7');for(const a of[-.34,.34])cube(x+a,z+.46,.22,.035,.23,.57,'#8fc4c6');
    for(const a of[-.39,.39])cube(x+a,z-.46,.08,.08,.42,.2,'#66745d');
    textAt('伙伴宿舍',x,z,1.34,'#fff0bd',w<=860?9:10);
  }
}
function spawnResource(){
  if(resources.length>=24)return;const raw=game.settings.salvage_loot,id=raw[Math.floor(Math.random()*raw.length)].item;
  let extent=9;for(const k of game.tiles)extent=Math.max(extent,...cell(k).map(n=>Math.abs(n*TILE)+3.5));
  for(let tries=0;tries<45;tries++){const x=(Math.random()*2-1)*extent,z=(Math.random()*2-1)*extent;if(game.tiles.has(key(Math.round(x/TILE),Math.round(z/TILE)))||resources.some(r=>Math.hypot(r.x-x,r.z-z)<.8))continue;resources.push({id,x,z,amount:2,life:65+Math.random()*25,phase:Math.random()*6});return;}
}
function drawResource(r){
  const bob=Math.sin(time*1.5+r.phase)*.04;ellipse(r.x,r.z,.4,.28,'#a3d0ba25',-.02);
  if(r.id==='wood'){for(let i=0;i<3;i++)cube(r.x,r.z+(i-1)*.12,.65,.1,.1,bob,'#d6b77c');}
  else if(r.id==='scrap'){cube(r.x,r.z,.45,.3,.22,bob-.04,'#9bbabc');cube(r.x+.09,r.z,.055,.31,.23,bob-.04,'#567e83');}
  else{cube(r.x,r.z,.39,.36,.31,bob-.01,'#e3d3ab');cube(r.x,r.z,.4,.07,.025,bob+.3,'#9a855b');}
}
function workerPose(){
  const job=game.construction;
  if(!job){const[x,z]=cell(game.landmarkCell('bian'));return {x:x*TILE,z:z*TILE,hammer:0};}
  const[a,b]=cell(job.from),[x,z]=cell(job.cell),progress=1-job.remaining/game.settings.construction_seconds,walk=Math.min(1,progress*4),reach=.52*walk;
  return {x:(a+(x-a)*reach)*TILE,z:(b+(z-b)*reach)*TILE,hammer:progress>.25?Math.sin(progress*55):0};
}
function drawWorker(){
  const{x,z,hammer}=workerPose();ellipse(x,z,.25,.2,'#493f3650',.24);
  for(const side of[-1,1]){cube(x+side*.12,z,.16,.21,.44,.24,'#454f59');cube(x+side*.12,z+.05,.17,.3,.1,.24,'#343b42');}
  cube(x,z,.48,.29,.49,.67,'#262b43');cube(x,z+.16,.28,.025,.12,.83,'#b6ab65');
  line3([[x-.27,z,1.04],[x-.35,z+.1,.77]],'#d3aa8d',Math.max(2,scale()*.1));
  const handY=.87+hammer*.13;line3([[x+.27,z,1.04],[x+.4,z+.15,handY]],'#d3aa8d',Math.max(2,scale()*.1));
  line3([[x+.4,z+.15,handY],[x+.57,z+.18,handY+.19]],'#bc965d',Math.max(2,scale()*.055));cube(x+.57,z+.18,.25,.12,.11,handY+.15,'#8eaaae');
  sprite(images.bian,x,z,.62,1.13);textAt(game.construction?'便 · 扩建中':'便 · 扩建工人',x,z,.04,'#f4d292',w<=860?10:11);
}
function drawConstruction(){
  const job=game.construction;if(!job)return;const[x,z]=cell(job.cell).map(n=>n*TILE),progress=1-job.remaining/game.settings.construction_seconds;
  cube(x,z,TILE*.92,TILE*.92,.06,.07,'#826c4f');
  for(let i=0;i<Math.floor(progress*5);i++)cube(x,z+(i-2)*TILE/5,TILE*.98,TILE/5-.02,.045,.18,'#ddbe89');
  for(const a of[-.58,.58])cube(x+a,z+.59,.055,.055,.55,.13,'#e9bc62');line3([[x-.58,z+.59,.64],[x+.58,z+.59,.64]],'#f1d37e',2);
  textAt(`施工 ${Math.round(progress*100)}%`,x,z,.85,'#f7d57f',10);
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
  const k=game.landmarkCell('food_supplier');if(!k)return;const[x,z]=cell(k).map(n=>n*TILE);
  ellipse(x,z,.55,.4,'#6f593850',.22);sprite(images.food_supplier,x,z,1.6,.24);
  cube(x,z+.23,1.05,.48,.42,.22,'#9a6a4e');cube(x,z+.23,1.12,.52,.06,.64,'#dec394');
  for(let n=0;n<3;n++){const p=project(x+(n-1)*.28,z+.23,.77);ctx.fillStyle='#f1e5bd';ctx.beginPath();ctx.ellipse(p.x,p.y,scale()*.12,scale()*.06,0,0,7);ctx.fill();ctx.fillStyle='#a56542';ctx.beginPath();ctx.ellipse(p.x,p.y-1,scale()*.085,scale()*.035,0,0,7);ctx.fill();}
  textAt('海岛食堂',x,z,1.94,'#ffdf9c',w<=860?9:11);
}
function landmarkPose(id){const[x,z]=cell(game.landmarkCell(id)).map(n=>n*TILE);return {x,z};}
function questShopPose(id){return landmarkPose(id);}
function drawQuestShop(id){const{x,z}=questShopPose(id),guide=characters.guides.find(row=>row.id===id),voyage=id==='renbo',color=voyage?'#629d99':'#aa7a52';ellipse(x,z,.54,.37,'#56473650',.21);cube(x,z+.18,1.04,.45,.38,.2,color);sprite(images[id],x,z,1.28,.21);cube(x,z+.2,1.12,.5,.07,.63,voyage?'#a9d3c9':'#d5bd91');const ready=game.questBoard(id).tasks.filter(task=>game.questComplete(task)).length;textAt(`${guide.name} · ${voyage?'出海':'建造'}任务${ready?` ${ready}份可领`:''}`,x,z,1.7,'#ffe3a6',w<=860?8:10);}
function recruiterPose(){return landmarkPose('muscle_frog');}
function employeePose(){return landmarkPose('zihao');}
function makerPose(){return landmarkPose('haozi');}
function drawRecruiter(){const{x,z}=recruiterPose();ellipse(x,z,.43,.3,'#6f593850',.21);sprite(images.muscle_frog,x,z,1.46,.24);textAt('肌肉蛙 · 员工招募',x,z,1.78,'#ffe08d',w<=860?9:11);}
function drawEmployee(){const{x,z}=employeePose(),count=game.employeeCount('zihao');if(!count)return;ellipse(x,z,.33,.24,'#526c7650',.21);sprite(images.zihao,x,z,1.28,.24);textAt(`自豪船队 ×${count} · 工作 ${game.employeeWorkingCount('zihao')}`,x,z,1.58,'#d9edff',w<=860?8:10);}
function drawMaker(){const{x,z}=makerPose(),count=game.employeeCount('haozi');if(!count)return;ellipse(x,z,.33,.24,'#526c7650',.21);sprite(images.haozi,x,z,1.27,.24);textAt(`豪自加工组 ×${count} · 工作 ${game.employeeWorkingCount('haozi')}`,x,z,1.58,'#e8e2ff',w<=860?8:10);}
const landmarkNames={food_supplier:'海岛食堂',renbo:'仁博任务铺',chaorui:'晁瑞任务铺',muscle_frog:'肌肉蛙',zihao:'自豪船队',haozi:'豪自加工组',bian:'便',flag:'浮岛旗帜'};
function activeLandmarkIds(){return ['food_supplier',...(game.introComplete()?['renbo','chaorui']:[]),'muscle_frog',...(game.employeeCount('zihao')?['zihao']:[]),...(game.employeeCount('haozi')?['haozi']:[]),...(!game.construction?['bian']:[]),'flag'];}
function decorationAt(x,y){
  let found=null,distance=Math.max(24,scale()*.7);for(const[k,b]of Object.entries(game.structures)){const[a,z]=cell(k).map(n=>n*TILE),p=project(a,z,.65),d=Math.hypot(p.x-x,p.y-y);if(d<distance){found={type:'structure',id:k,name:game.buildings[b.id].name};distance=d;}}
  for(const id of activeLandmarkIds()){const k=game.landmarkCell(id),[a,z]=cell(k).map(n=>n*TILE),p=project(a,z,.72),d=Math.hypot(p.x-x,p.y-y);if(d<distance){found={type:'landmark',id,name:landmarkNames[id]};distance=d;}}
  return found;
}
function decorationTargetValid(k){if(!decorateSelection||!game.tiles.has(k))return false;if(decorateSelection.type==='landmark')return (!game.structures[k]&&(!game.landmarkAt(k)||game.landmarkAt(k)===decorateSelection.id));const structure=game.structures[decorateSelection.id];return Boolean(structure)&&(k===decorateSelection.id||(!game.structures[k]&&!game.landmarkAt(k)))&&(structure.id!=='dock'||game.edge(k));}
function drawDecorationHighlight(){
  if(mode!=='decorate'||paused)return;const cells=[];if(decorateSelection){const k=decorateSelection.type==='structure'?decorateSelection.id:game.landmarkCell(decorateSelection.id);cells.push({k,color:'#f4c86d'});}if(hover)cells.push({k:hover,color:decorationTargetValid(hover)?'#7fe0b0':'#df7868'});
  ctx.save();ctx.globalAlpha=.5;for(const{k,color}of cells){const[x,z]=cell(k).map(n=>n*TILE),corners=[[-.68,-.68],[.68,-.68],[.68,.68],[-.68,.68]].map(([a,b])=>project(x+a,z+b,.29));polygon(corners,color,'#fff4d1');}ctx.restore();
}
function drawPreview(){
  if(mode==='decorate'){drawDecorationHighlight();return;}if(mode==='collect'||!hover||paused)return;const[x,z]=cell(hover).map(n=>n*TILE),valid=!game.placementError(mode,hover);const corners=[[-.69,-.69],[.69,-.69],[.69,.69],[-.69,.69]].map(([a,b])=>project(x+a,z+b,.26));
  ctx.save();ctx.globalAlpha=.56;polygon(corners,valid?'#8ed4ae':'#de836f','#fff0d8');if(mode!=='expand')drawBuilding(hover,{id:mode,rotation});ctx.restore();
}
function draw(){
  drawWater();
  if(game.atSea()){
    resources.slice().sort((a,b)=>project(a.x,a.z).y-project(b.x,b.z).y).forEach(drawResource);
    drawBoat({x:0,z:0,color:'e5b45f'});if(game.companion.equipped)sprite(images.yue,-.65,-.1,1.25,.5+Math.sin(time*2)*.04);sprite(images.naiwa,.25,.4,1.4,.3+Math.sin(time*2)*.04);textAt(game.companion.equipped?`奶蛙 & 樾 Lv.${game.companion.level}`:'奶蛙 · 出海中',0,0,2.1,'#fff1c5',w<=860?11:13);return;
  }
  const tiles=[...game.tiles].sort((a,b)=>{const[x,z]=cell(a),[xx,zz]=cell(b);return project(x,z).y-project(xx,zz).y;});for(const k of tiles)drawTile(k);drawConstruction();
  const entities=resources.map(r=>({depth:project(r.x,r.z).y,draw:()=>drawResource(r)}));
  for(const[k,b]of Object.entries(game.structures)){const[x,z]=cell(k).map(n=>n*TILE);entities.push({depth:project(x,z).y,draw:()=>drawBuilding(k,b)});}
  const vendor=game.reservedCell();if(vendor){const[x,z]=cell(vendor).map(n=>n*TILE);entities.push({depth:project(x,z+.2).y,draw:drawVendor});}
  if(game.introComplete())for(const id of ['renbo','chaorui']){const shop=questShopPose(id);entities.push({depth:project(shop.x,shop.z).y,draw:()=>drawQuestShop(id)});}
  const recruiter=recruiterPose();entities.push({depth:project(recruiter.x,recruiter.z).y,draw:drawRecruiter});
  if(game.employeeCount('zihao')){const employee=employeePose(),employeeBoat={x:4.15,z:1.65,color:'5f91b6'};entities.push({depth:project(employeeBoat.x,employeeBoat.z).y,draw:()=>drawBoat(employeeBoat)});entities.push({depth:project(employee.x,employee.z).y,draw:drawEmployee});}
  if(game.employeeCount('haozi')){const maker=makerPose();entities.push({depth:project(maker.x,maker.z).y,draw:drawMaker});}
  const worker=workerPose();entities.push({depth:project(worker.x,worker.z).y,draw:drawWorker});
  entities.push({depth:project(hero.x,hero.z).y,draw:()=>{ellipse(hero.x,hero.z,.31,.23,'#8a704550',.235);sprite(images.naiwa,hero.x,hero.z,characters.hero.world_height,.24+Math.sin(time*(hero.path.length?11:2))*(hero.path.length?.06:.012),hero.flip);textAt('奶蛙',hero.x,hero.z,2.25,'#fff2bf',w<=860?10:11);}});
  for(const boat of boats.values())entities.push({depth:project(boat.x,boat.z).y,draw:()=>drawBoat(boat)});
  entities.sort((a,b)=>a.depth-b.depth);entities.forEach(e=>e.draw());drawPreview();
  const flag=landmarkPose('flag');line3([[flag.x,flag.z,.23],[flag.x,flag.z,1.8]],'#e4cd94',2.5);polygon([project(flag.x,flag.z,1.8),project(flag.x+.67,flag.z,1.63),project(flag.x,flag.z,1.48)],'#e9b45f');
}
function update(dt){
  time+=dt;game.syncClock();if(paused)return;game.tick(dt);spawnClock+=dt;saveClock+=dt;
  if(spawnClock>=game.settings.floating_interval_seconds){spawnClock=0;if(game.atSea())spawnResource();}if(saveClock>=20){saveClock=0;save();}
  for(const r of resources){r.life-=dt;r.x+=dt*.035;}resources=resources.filter(r=>r.life>0&&!game.tiles.has(key(Math.round(r.x/TILE),Math.round(r.z/TILE))));
  const dockCells=Object.entries(game.structures).filter(([,structure])=>structure.id==='dock').map(([k])=>k);const active=new Set();for(const v of game.visitors){active.add(v.slot);const dock=dockCells[v.slot]||dockCells[0],[gx,gz]=cell(dock),[cx,cz]=[gx*TILE,gz*TILE],[ox,oz]=directions.find(([dx,dz])=>!game.tiles.has(key(gx+dx,gz+dz)))||[0,1],distance=1.25+Math.max(0,1-v.age/2)*8;let b=boats.get(v.slot);if(!b){b={x:cx+ox*TILE*distance,z:cz+oz*TILE*distance,color:game.npcs[v.npc].color};boats.set(v.slot,b);}b.x=cx+ox*TILE*distance;b.z=cz+oz*TILE*distance;}
  for(const[slot,b]of boats)if(!active.has(slot)){b.z+=dt*3.5;if(b.z>17)boats.delete(slot);}
  if(hero.path.length){const k=hero.path[0],[x,z]=cell(k).map(n=>n*TILE),dx=x-hero.x,dz=z-hero.z,d=Math.hypot(dx,dz),step=dt*2.8;hero.flip=project(x,z).x>project(hero.x,hero.z).x;if(d<=step){hero.x=x;hero.z=z;hero.cell=k;hero.path.shift();}else{hero.x+=dx/d*step;hero.z+=dz/d*step;}}
  if(keys.has('KeyQ'))yaw-=dt;if(keys.has('KeyE'))yaw+=dt;
  const dx=Number(keys.has('KeyD'))-Number(keys.has('KeyA')),dz=Number(keys.has('KeyS'))-Number(keys.has('KeyW'));pan.x=Math.max(-12,Math.min(12,pan.x+(dx*Math.cos(yaw)+dz*Math.sin(yaw))*dt*5));pan.z=Math.max(-12,Math.min(12,pan.z+(-dx*Math.sin(yaw)+dz*Math.cos(yaw))*dt*5));
}
function resourceAt(x,y){let found=null,distance=Math.max(20,scale()*.48);for(const r of resources){const p=project(r.x,r.z,.14),d=Math.hypot(p.x-x,p.y-y);if(d<distance){found=r;distance=d;}}return found;}
function decorateClick(x,y){
  if(!decorateSelection){decorateSelection=decorationAt(x,y);notify(decorateSelection?`已选择${decorateSelection.name}，再点击目标平台`:'这里没有可移动的建筑或地标');updateHint();return;}
  const p=unproject(x,y),target=key(Math.round(p.x/TILE),Math.round(p.z/TILE)),name=decorateSelection.name,error=decorateSelection.type==='structure'?game.moveStructure(decorateSelection.id,target):game.moveLandmark(decorateSelection.id,target);
  if(error){notify(error);return;}decorateSelection=null;save();notify(`${name}已移动到新位置`);updateHint();
}
function clickWorld(x,y){
  if(paused)return;
  if(game.atSea()){const r=resourceAt(x,y);if(r){const n=game.collect(r.id,r.amount);if(n){r.amount-=n;if(!r.amount)resources.splice(resources.indexOf(r),1);notify(`奶蛙打捞到 ${game.items[r.id].name} +${n}`);}}return;}
  if(mode==='decorate'){decorateClick(x,y);return;}
  const vendor=game.reservedCell();if(vendor){const[a,b]=cell(vendor).map(n=>n*TILE),p=project(a,b,.8);if(Math.hypot(x-p.x,y-p.y)<Math.max(24,scale()*.75)){openDialog('#food-dialog');return;}}
  if(game.introComplete())for(const id of ['renbo','chaorui']){const shop=questShopPose(id),point=project(shop.x,shop.z,.75);if(Math.hypot(x-point.x,y-point.y)<Math.max(28,scale()*.72)){openDialog(`#${id}-task-dialog`);return;}}
  const recruiter=recruiterPose(),recruiterPoint=project(recruiter.x,recruiter.z,.8);if(Math.hypot(x-recruiterPoint.x,y-recruiterPoint.y)<Math.max(28,scale()*.8)){openDialog('#recruit-dialog');return;}
  if(game.employeeCount('zihao')){const employee=employeePose(),employeePoint=project(employee.x,employee.z,.7);if(Math.hypot(x-employeePoint.x,y-employeePoint.y)<Math.max(25,scale()*.65)){openDialog('#recruit-dialog');return;}}
  if(game.employeeCount('haozi')){const maker=makerPose(),makerPoint=project(maker.x,maker.z,.7);if(Math.hypot(x-makerPoint.x,y-makerPoint.y)<Math.max(25,scale()*.65)){openDialog('#recruit-dialog');return;}}
  const r=resourceAt(x,y);if(r){const n=game.collect(r.id,r.amount);if(n){r.amount-=n;if(!r.amount)resources.splice(resources.indexOf(r),1);notify(`奶蛙打捞到 ${game.items[r.id].name} +${n}`);}return;}
  const p=unproject(x,y),k=key(Math.round(p.x/TILE),Math.round(p.z/TILE));
  if(mode!=='collect'){const built=mode,error=game.build(built,k,rotation);notify(error||(built==='expand'?'便已接下扩建，正在施工…':`${game.buildings[built].name}已建好`));if(!error){save();if(built==='dormitory'){selectMode('collect');openDialog('#dorm-dialog');}}return;}
  if(game.structures[k]?.id==='dormitory'){openDialog('#dorm-dialog');return;}
  for(const[slot,b]of boats){const p=project(b.x,b.z,.3);if(Math.hypot(x-p.x,y-p.y)<Math.max(22,scale()*.5)){const error=game.trade(slot);if(error)notify(error);return;}}
  pathTo(k);
}
function bindInput(){
  addEventListener('resize',resize);canvas.addEventListener('contextmenu',e=>{e.preventDefault();selectMode('collect');});
  canvas.addEventListener('pointerdown',e=>{if(e.button!==0&&e.button!==1)return;drag={x:e.clientX,y:e.clientY,pan:{...pan},button:e.button};dragged=false;canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{pointer={x:e.clientX,y:e.clientY};const p=unproject(pointer.x,pointer.y);hover=key(Math.round(p.x/TILE),Math.round(p.z/TILE));if(drag&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>8){dragged=true;const a=unproject(drag.x,drag.y),b=unproject(e.clientX,e.clientY);pan.x+=a.x-b.x;pan.z+=a.z-b.z;drag.x=e.clientX;drag.y=e.clientY;}canvas.style.cursor=mode==='decorate'?'grab':mode!=='collect'?'crosshair':resourceAt(pointer.x,pointer.y)?'pointer':'default';updateHint();});
  canvas.addEventListener('pointerup',e=>{if(drag&&!dragged&&e.button===0)clickWorld(e.clientX,e.clientY);drag=null;});canvas.addEventListener('pointercancel',()=>drag=null);
  canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(32,Math.min(82,zoom-e.deltaY*.03));},{passive:false});
  addEventListener('keydown',e=>{if(['Space','ArrowUp','ArrowDown'].includes(e.code))e.preventDefault();if(e.target.closest('button,dialog,input,select'))return;if($$('dialog').some(d=>d.open))return;if(e.code==='Escape'){selectMode('collect');setSheet('none');}if(e.code==='Space'&&!e.repeat){paused=!paused;render();}if(e.code==='KeyR')rotation=(rotation+1)%4;if(e.code==='KeyF'){pan={x:0,z:0};yaw=.65;}if(e.code==='F5'){e.preventDefault();save(true);}keys.add(e.code);});addEventListener('keyup',e=>keys.delete(e.code));addEventListener('blur',()=>keys.clear());
  document.addEventListener('visibilitychange',()=>{keys.clear();if(document.hidden)save();lastFrame=0;});addEventListener('pagehide',()=>save());
}
function frame(now){const dt=lastFrame?Math.min((now-lastFrame)/1000,.1):0;lastFrame=now;if(!document.hidden){update(dt);draw();uiClock+=dt;if(uiClock>.15){uiClock=0;renderRecipes();renderVisitors();renderJourney();renderCompanion();if($('#food-dialog').open)renderVendor();if($('#recruit-dialog').open)renderRecruitment();if($('#renbo-task-dialog').open||$('#chaorui-task-dialog').open)renderQuestBoards();if($('#dorm-dialog').open)renderDorm();}}requestAnimationFrame(frame);}
function loadCharacter(row){return new Promise((resolve,reject)=>{const image=new Image();image.decoding='async';image.onload=()=>{images[row.id]=image;resolve();};image.onerror=()=>reject(Error(`角色图片无法加载：${row.name}`));image.src=row.image;});}
async function start(){
  try{
    const [catalog,defs]=await Promise.all(['./data/catalog.json','./data/characters.json'].map(async path=>{const r=await fetch(path);if(!r.ok)throw Error('配置加载失败');return r.json();}));characters=defs;game=new Economy(catalog);
    try{const saved=localStorage.getItem(STORE);if(saved){const error=game.restore(JSON.parse(saved));if(error){saveBlocked=true;setTimeout(()=>notify(error),1000);}}}catch{saveBlocked=true;setTimeout(()=>notify('本地存档不可用；仍可试玩。需要时可下载存档。'),1000);}
    const sources=[defs.hero,...defs.guides,...defs.suppliers,...defs.companions,...defs.workers,...(defs.recruiters||[]),...(defs.employees||[])],criticalIds=new Set(['naiwa','food_supplier','bian','muscle_frog']);if(game.introComplete()){criticalIds.add('renbo');criticalIds.add('chaorui');}if(game.employeeCount('zihao'))criticalIds.add('zihao');if(game.employeeCount('haozi'))criticalIds.add('haozi');if(game.atSea()&&game.companion.equipped)criticalIds.add('yue');const critical=sources.filter(row=>criticalIds.has(row.id)),deferred=sources.filter(row=>!criticalIds.has(row.id));await Promise.all(critical.map(loadCharacter));
    setupUI();started=true;game.onChange=render;game.onNotice=notify;render();resize();bindInput();$('#hud').hidden=false;$('#loading').style.opacity=0;setTimeout(()=>$('#loading').remove(),350);requestAnimationFrame(frame);
    Promise.allSettled(deferred.map(loadCharacter)).then(results=>{for(const result of results)if(result.status==='rejected')console.warn(result.reason);});
  }catch(error){$('#loading-message').textContent=`${error.message}，请刷新重试。`;console.error(error);}
}
start();
