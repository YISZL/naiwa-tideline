export const key = (x,z) => `${x},${z}`;
export const cell = k => k.split(',').map(Number);
export const directions = [[1,0],[-1,0],[0,1],[0,-1]];
const positive = n => Number.isSafeInteger(n) && n > 0;
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
export class Economy {
  constructor(catalog) {
    this.catalog = catalog;
    for (const section of ['items','recipes','buildings','npcs','vendors']) {
      if (!Array.isArray(catalog[section])) throw Error(`配置缺少 ${section}`);
      this[section] = Object.fromEntries(catalog[section].map(row=>[row.id,row]));
      if (Object.keys(this[section]).length !== catalog[section].length) throw Error('配置 ID 重复');
    }
    this.settings = catalog.settings;
    this.onChange = ()=>{};
    this.onNotice = ()=>{};
    this.reset();
  }
  reset() {
    this.inventory = Object.fromEntries(Object.keys(this.items).map(id=>[id,this.settings.starting_inventory[id]||0]));
    this.coins=this.settings.starting_coins; this.reputation=0; this.trades=0; this.gathered=0;
    this.tiles = new Set(); for(let x=-2;x<=2;x++)for(let z=-2;z<=2;z++)this.tiles.add(key(x,z));
    this.structures={'0,2':{id:'dock',rotation:0}};
    this.landmarks={food_supplier:'1,-1',renbo:'-2,0',chaorui:'2,0',muscle_frog:'-2,-1',zihao:'2,1',haozi:'1,2',bian:'-1,1',flag:'-2,-2'};
    this.queue=[]; this.visitors=[]; this.clock=0; this.nextVisitor=0; this.elapsed=0;
    this.stamina=this.settings.max_stamina;this.staminaAt=Date.now();this.voyageUntil=0;this.salvageUntil=0;
    this.companion={level:1,xp:0,equipped:true};
    this.housing={dorm:null,trainedAt:0,progress:0};
    this.employees={zihao:[],haozi:[]};
    this.employeeMeals={zihao:[],haozi:[]};
    this.employeeJobs={haozi:[]};
    this.questStats={voyages:0,salvages:0,gathered:0,expanded:0,built:0,crafted:0};
    this.questBoards={renbo:{refreshedAt:0,serial:0,tasks:[]},chaorui:{refreshedAt:0,serial:0,tasks:[]}};
    this.construction=null;
    this.spawnVisitor();this.onChange();
  }
  count(id){return this.inventory[id]||0;}
  has(id){return Object.values(this.structures).some(b=>b.id===id);}
  capacity(){return this.settings.base_capacity+Object.values(this.structures).filter(b=>b.id==='warehouse').length*this.settings.warehouse_capacity;}
  rawTotal(){return Object.values(this.items).filter(i=>i.kind==='resource').reduce((n,i)=>n+this.count(i.id),0);}
  afford(cost,coins=0){return this.coins>=coins&&Object.entries(cost).every(([id,n])=>this.count(id)>=n);}
  spend(cost,coins=0){for(const [id,n]of Object.entries(cost))this.inventory[id]=this.count(id)-n;this.coins-=coins;}
  collect(id,n=2){
    this.syncClock();if(!this.atSea()){this.onNotice('先出海，才能打捞物资');return 0;}
    if(!this.items[id]||!positive(n))return 0;
    const amount=this.items[id].kind==='resource'?Math.min(n,Math.max(0,this.capacity()-this.rawTotal())):n;
    if(!amount){this.onNotice('原料仓已满，制作道具或建造仓库可腾出空间');return 0;}
    this.inventory[id]=this.count(id)+amount;this.gathered+=amount;this.questStats.gathered+=amount;this.onChange();return amount;
  }
  craftError(id){const r=this.recipes[id];if(!r)return '配方不存在';if(this.atSea())return '返航后安排制作';if(!this.has('workshop'))return '先在浮岛上建造加工台';if(this.reputation<r.reputation)return `声望 ${r.reputation} 解锁`;if(this.queue.length>=this.settings.queue_limit)return '制作队列已满';if(!this.afford(r.cost))return '材料不足，出海打捞，或找供应商买饭吧';return '';}
  craft(id){const error=this.craftError(id);if(error)return error;const r=this.recipes[id];this.spend(r.cost);this.queue.push({recipe:id,remaining:r.seconds});this.onChange();return '';}
  edge(k){const [x,z]=cell(k);return directions.some(([dx,dz])=>!this.tiles.has(key(x+dx,z+dz)));}
  landmarkActive(id){return !['renbo','chaorui','zihao','haozi'].includes(id)||(id==='renbo'||id==='chaorui'?this.introComplete():this.employeeCount(id)>0);}
  landmarkCell(id){return this.landmarks[id]||null;}
  landmarkAt(k,exclude=null){return Object.entries(this.landmarks).find(([id,cell])=>id!==exclude&&cell===k)?.[0]||null;}
  reservedCell(){return this.landmarkCell('food_supplier');}
  orderCapacity(){return Object.values(this.structures).filter(b=>b.id==='dock').length;}
  placementError(mode,k){
    if(this.atSea())return '返航后才能建造';
    const [x,z]=cell(k);if(!Number.isInteger(x)||!Number.isInteger(z)||Math.max(Math.abs(x),Math.abs(z))>this.settings.max_grid_radius)return '超出可扩建范围';
    if(mode==='expand'){
      if(this.construction)return '便正在施工，请等待当前扩建完成';
      if(this.tiles.has(k))return '这里已有平台';
      if(!directions.some(([dx,dz])=>this.tiles.has(key(x+dx,z+dz))))return '平台必须连接现有浮岛';
      for(const [pos,b]of Object.entries(this.structures)){if(b.id!=='dock')continue;const[a,c]=cell(pos);if(!directions.some(([dx,dz])=>!this.tiles.has(key(a+dx,c+dz))&&key(a+dx,c+dz)!==k))return '码头旁需要保留水面';}
      return this.afford(this.settings.expansion_cost)?'':'浮木不足';
    }
    const b=this.buildings[mode];if(!b)return '请选择建筑';
    if(mode==='workshop'&&this.has(mode))return `${b.name}已有一座`;
    if(!this.tiles.has(k))return '先在这里扩建平台';if(this.structures[k])return '这里已有建筑';const landmark=this.landmarkAt(k);if(landmark)return '这里已有岛上地标';
    if(mode==='dock'&&!this.edge(k))return '码头需要建在边缘';return this.afford(b.cost,b.coins)?'':'材料或金币不足';
  }
  build(mode,k,rotation=0){const error=this.placementError(mode,k);if(error)return error;if(mode==='expand'){this.spend(this.settings.expansion_cost);const[x,z]=cell(k),from=directions.map(([dx,dz])=>key(x+dx,z+dz)).find(p=>this.tiles.has(p));this.construction={cell:k,from,remaining:this.settings.construction_seconds};}else{const b=this.buildings[mode];this.spend(b.cost,b.coins);this.structures[k]={id:mode,rotation:((rotation%4)+4)%4};this.questStats.built++;if(mode==='dock')this.spawnVisitor();}this.onChange();return '';}
  moveStructure(from,to,rotation=null){
    if(this.atSea())return '返航后才能装修';const structure=this.structures[from];if(!structure)return '请选择要移动的建筑';if(!this.tiles.has(to))return '只能移动到现有平台';if(from===to){if(rotation!==null)structure.rotation=((rotation%4)+4)%4;this.onChange();return '';}
    if(this.structures[to])return '目标平台已有建筑';if(this.landmarkAt(to))return '目标平台已有岛上地标';if(structure.id==='dock'&&!this.edge(to))return '码头需要放在浮岛边缘';
    delete this.structures[from];this.structures[to]={...structure,rotation:rotation===null?structure.rotation:((rotation%4)+4)%4};if(this.housing.dorm===from)this.housing.dorm=to;this.onChange();return '';
  }
  moveLandmark(id,to){
    if(this.atSea())return '返航后才能装修';if(!Object.hasOwn(this.landmarks,id))return '地标不存在';if(!this.tiles.has(to))return '地标只能放在现有平台';if(this.structures[to])return '目标平台已有建筑';if(this.landmarkAt(to,id))return '目标平台已有岛上地标';this.landmarks[id]=to;this.onChange();return '';
  }
  purchaseError(vendorId,index=0){const offer=this.vendors[vendorId]?.offers[index];if(!offer)return '商品不存在';if(this.atSea())return '返航后购买';if(this.coins<offer.price)return '金币不足，先完成一些订单吧';if(!this.has('workshop')&&this.coins-offer.price<this.buildings.workshop.coins)return '先留够建造加工台的金币，再来买饭吧';if(this.items[offer.item].kind==='resource'&&this.rawTotal()+offer.quantity>this.capacity())return '原料仓容量不足';return '';}
  buy(vendorId,index=0){const error=this.purchaseError(vendorId,index);if(error)return error;const offer=this.vendors[vendorId].offers[index];this.coins-=offer.price;this.inventory[offer.item]=this.count(offer.item)+offer.quantity;this.onChange();this.onNotice(`购买成功：${this.items[offer.item].name} +${offer.quantity}`);return '';}
  employeeCount(id){return this.employees[id]?.length||0;}
  hireEmployeeError(id){const config=this.settings.employees?.[id];if(!config)return '员工不存在';if(this.atSea())return '返航后才能招募员工';if(this.employeeCount(id)>=config.max)return `${config.name}已达到招募上限`;if(this.coins<config.price)return `金币不足，还需要 ${config.price-this.coins} 金币`;return '';}
  hireEmployee(id,now=Date.now()){
    this.syncClock(now);const error=this.hireEmployeeError(id);if(error)return error;const config=this.settings.employees[id];
    this.coins-=config.price;this.employees[id].push(now+(config.voyage_seconds||0)*1000);this.employeeMeals[id].push(now+this.settings.employee_meal_seconds*1000);if(id==='haozi')this.employeeJobs.haozi.push(null);this.onChange();this.onNotice(id==='zihao'?'招募成功：自豪 ×1，船队将在 10 分钟后带回物资':'招募成功：豪自 ×1，将自动处理码头订单');return '';
  }
  employeeSecondsRemaining(id,now=Date.now()){const timers=this.employees[id]||[];return timers.length?Math.max(0,Math.ceil((Math.min(...timers)-now)/1000)):0;}
  employeeMealSecondsRemaining(id,now=Date.now()){const meals=this.employeeMeals[id]||[],active=meals.filter(Boolean);return active.length?Math.max(0,Math.ceil((Math.min(...active)-now)/1000)):0;}
  employeeWorkingCount(id){return (this.employeeMeals[id]||[]).filter(Boolean).length;}
  syncEmployeeMeal(id,index,now){
    const meals=this.employeeMeals[id],step=this.settings.employee_meal_seconds*1000,due=meals[index];
    if(due===0){if(this.count('pork_rice')<1)return {activeUntil:0,dirty:false,resumed:false,stopped:false,ate:0};this.inventory.pork_rice--;meals[index]=now+step;return {activeUntil:now,dirty:true,resumed:true,stopped:false,ate:1};}
    if(now<due)return {activeUntil:now,dirty:false,resumed:false,stopped:false,ate:0};
    const needed=Math.floor((now-due)/step)+1,available=Math.min(needed,this.count('pork_rice'));this.inventory.pork_rice-=available;
    if(available<needed){const activeUntil=Math.min(now,due+available*step);meals[index]=0;return {activeUntil,dirty:true,resumed:false,stopped:true,ate:available};}
    meals[index]=due+available*step;return {activeUntil:now,dirty:true,resumed:false,stopped:false,ate:available};
  }
  rollEmployeeLoot(rng=Math.random){const table=this.settings.salvage_loot,total=table.reduce((n,row)=>n+row.weight,0);let pick=rng()*total,loot=table.at(-1);for(const row of table){pick-=row.weight;if(pick<0){loot=row;break;}}return {item:loot.item,quantity:loot.min+Math.floor(rng()*(loot.max-loot.min+1))};}
  recipeForOrder(item,quantity,seen=new Set()){
    if(this.count(item)>=quantity||seen.has(item))return null;const recipe=Object.values(this.recipes).find(row=>row.output===item);if(!recipe||this.reputation<recipe.reputation)return null;seen.add(item);
    for(const [ingredient,needed]of Object.entries(recipe.cost)){if(this.count(ingredient)>=needed)continue;const nested=this.recipeForOrder(ingredient,needed,new Set(seen));if(nested)return nested;return null;}
    return this.afford(recipe.cost)?recipe:null;
  }
  autoTrade(slot){const index=this.visitors.findIndex(visitor=>visitor.slot===slot);if(index<0)return false;const visitor=this.visitors[index];if(visitor.age<2||this.count(visitor.item)<visitor.quantity)return false;this.inventory[visitor.item]-=visitor.quantity;this.coins+=visitor.reward;this.reputation++;this.trades++;this.visitors.splice(index,1);this.refreshQuests();this.onNotice(`豪自完成码头订单：金币 +${visitor.reward} · 声望 +1`);return true;}
  syncHaoziWorker(index,limit,now,reserved){
    let dirty=false,cursor=now,job=this.employeeJobs.haozi[index];
    for(let guard=0;guard<24;guard++){
      if(job){reserved.add(job.slot);if(job.completeAt>limit)break;cursor=job.completeAt;const completedSlot=job.slot,recipe=this.recipes[job.recipe];this.inventory[recipe.output]=this.count(recipe.output)+recipe.amount;this.questStats.crafted+=recipe.amount;this.employeeJobs.haozi[index]=job=null;reserved.delete(completedSlot);dirty=true;}
      if(cursor>limit)break;const visitor=this.visitors.find(row=>row.age>=2&&!reserved.has(row.slot));if(!visitor)break;reserved.add(visitor.slot);
      if(this.count(visitor.item)>=visitor.quantity){dirty=this.autoTrade(visitor.slot)||dirty;reserved.delete(visitor.slot);continue;}
      const recipe=this.recipeForOrder(visitor.item,visitor.quantity);if(!recipe){reserved.delete(visitor.slot);break;}this.spend(recipe.cost);job={recipe:recipe.id,slot:visitor.slot,completeAt:cursor+recipe.seconds*1000,remaining:0};this.employeeJobs.haozi[index]=job;dirty=true;if(job.completeAt>limit)break;
    }
    return dirty;
  }
  syncEmployees(now=Date.now(),rng=Math.random){
    let dirty=false,returns=0,stored=0,overflow=false,ate=0,stopped=0,resumed=0;const rewards={},timers=this.employees.zihao||[],step=this.settings.employees.zihao.voyage_seconds*1000;
    for(let i=0;i<timers.length;i++){
        const meal=this.syncEmployeeMeal('zihao',i,now);dirty=meal.dirty||dirty;ate+=meal.ate;stopped+=Number(meal.stopped);resumed+=Number(meal.resumed);if(meal.resumed)timers[i]=now+step;
        if(meal.activeUntil&&timers[i]<=meal.activeUntil){const trips=Math.floor((meal.activeUntil-timers[i])/step)+1;timers[i]+=trips*step;returns+=trips;dirty=true;
        for(let trip=0;trip<trips&&this.rawTotal()<this.capacity();trip++){
          const loot=this.rollEmployeeLoot(rng),amount=Math.min(loot.quantity,Math.max(0,this.capacity()-this.rawTotal()));
          if(amount<loot.quantity)overflow=true;if(!amount)continue;this.inventory[loot.item]=this.count(loot.item)+amount;this.gathered+=amount;rewards[loot.item]=(rewards[loot.item]||0)+amount;stored+=amount;
        }
        if(this.rawTotal()>=this.capacity())overflow=true;
        }
        if(meal.stopped)timers[i]=now+step;
    }
    const reserved=new Set(this.employeeJobs.haozi.filter(Boolean).map(job=>job.slot));
    for(let i=0;i<this.employees.haozi.length;i++){
      const meal=this.syncEmployeeMeal('haozi',i,now);dirty=meal.dirty||dirty;ate+=meal.ate;stopped+=Number(meal.stopped);resumed+=Number(meal.resumed);let job=this.employeeJobs.haozi[i];
      if(meal.resumed&&job?.remaining){job.completeAt=now+job.remaining;job.remaining=0;dirty=true;}
      if(meal.activeUntil)dirty=this.syncHaoziWorker(i,meal.activeUntil,now,reserved)||dirty;job=this.employeeJobs.haozi[i];
      if(meal.stopped&&job?.completeAt>meal.activeUntil){job.remaining=job.completeAt-meal.activeUntil;job.completeAt=0;dirty=true;}
    }
    if(returns){const detail=Object.entries(rewards).map(([id,n])=>`${this.items[id].name} +${n}`).join(' · ');this.onNotice(stored?`自豪船队返航 ${returns} 次：${detail}${overflow?' · 仓库已满，部分物资未能入库':''}`:'自豪船队已返航，但原料仓已满');}
    if(stopped)this.onNotice(`${stopped} 名员工因缺少猪脚饭停止工作`);else if(resumed)this.onNotice(`${resumed} 名员工吃过猪脚饭，恢复工作`);else if(ate)this.onNotice(`员工用餐：猪脚饭 -${ate}`);
    return dirty;
  }
  introComplete(){return this.has('workshop')&&this.trades>0&&this.reputation>=3;}
  questMetric(metric){return this.questStats[metric]??0;}
  questProgress(task){return Math.min(task.goal,Math.max(0,this.questMetric(task.metric)-task.start));}
  questComplete(task){return this.questProgress(task)>=task.goal;}
  questBoard(id){return this.questBoards[id];}
  fillQuestBoard(id,rng=Math.random){
    const board=this.questBoards[id],templates=this.settings.quests?.boards?.[id];if(!board||!templates)return false;
    let dirty=false;while(board.tasks.length<this.settings.quests.max_per_board){const template=templates[board.serial%templates.length],goal=template.min+Math.floor(rng()*(template.max-template.min+1));board.serial++;board.tasks.push({id:`${id}-${board.serial}`,kind:template.kind,metric:template.metric,name:template.name,unit:template.unit,goal,start:this.questMetric(template.metric)});dirty=true;}return dirty;
  }
  refreshQuests(now=Date.now(),rng=Math.random){
    if(!this.introComplete())return false;let dirty=false;const step=this.settings.quests.refresh_seconds*1000;
    for(const id of Object.keys(this.settings.quests.boards)){const board=this.questBoards[id];if(!board.refreshedAt){board.refreshedAt=now;dirty=true;dirty=this.fillQuestBoard(id,rng)||dirty;continue;}if(now<board.refreshedAt){board.refreshedAt=now;dirty=true;}const cycles=Math.floor((now-board.refreshedAt)/step);if(cycles>0){board.refreshedAt+=cycles*step;dirty=true;dirty=this.fillQuestBoard(id,rng)||dirty;}}
    return dirty;
  }
  questRefreshSeconds(id,now=Date.now()){const board=this.questBoards[id];if(!board?.refreshedAt)return 0;const step=this.settings.quests.refresh_seconds*1000;return Math.max(0,Math.ceil((board.refreshedAt+step-now)/1000));}
  claimQuestError(boardId,taskId){const board=this.questBoards[boardId],task=board?.tasks.find(row=>row.id===taskId);if(!this.introComplete())return '先完成开场任务';if(this.atSea())return '返航后到任务铺交接';if(!task)return '任务不存在或已经领取';if(!this.questComplete(task))return '任务尚未完成';return '';}
  claimQuest(boardId,taskId,rng=Math.random){
    this.syncClock(Date.now(),rng);const error=this.claimQuestError(boardId,taskId);if(error)return {error};const board=this.questBoards[boardId],index=board.tasks.findIndex(row=>row.id===taskId),task=board.tasks[index],rewards=this.settings.quests;
    let reward;if(rng()<.5||this.rawTotal()>=this.capacity()){const amount=rewards.coin_reward.min+Math.floor(rng()*(rewards.coin_reward.max-rewards.coin_reward.min+1));this.coins+=amount;reward={type:'coins',amount};}else{const items=this.settings.salvage_loot.map(row=>row.item),item=items[Math.floor(rng()*items.length)],rolled=rewards.material_reward.min+Math.floor(rng()*(rewards.material_reward.max-rewards.material_reward.min+1)),amount=Math.min(rolled,this.capacity()-this.rawTotal());if(amount>0){this.inventory[item]=this.count(item)+amount;reward={type:'item',item,amount};}else{const amount=rewards.coin_reward.min;this.coins+=amount;reward={type:'coins',amount};}}
    board.tasks.splice(index,1);this.onChange();const detail=reward.type==='coins'?`金币 +${reward.amount}`:`${this.items[reward.item].name} +${reward.amount}`;this.onNotice(`${boardId==='renbo'?'仁博':'晁瑞'}任务完成：${detail}`);return {error:'',reward,task};
  }
  spawnVisitor(){
    if(this.visitors.length>=this.orderCapacity()||!this.has('dock'))return;
    const ids=Object.keys(this.npcs),id=ids[this.nextVisitor++%ids.length];
    const prefs=this.npcs[id].preferences.filter(p=>(!p.requires_owned||this.count(p.item)>=p.quantity)&&!Object.values(this.recipes).some(r=>r.output===p.item&&r.reputation>this.reputation));
    if(!prefs.length)return;const p=prefs[Math.floor(Math.random()*prefs.length)];let slot=0;while(this.visitors.some(v=>v.slot===slot))slot++;
    this.visitors.push({npc:id,...p,slot,remaining:this.settings.visitor_seconds,age:0});this.onChange();
  }
  tradeError(slot){if(this.atSea())return '返航后交付订单';const v=this.visitors.find(v=>v.slot===slot);if(!v)return '顾客已离港';if(v.age<2)return '顾客正在靠岸';if(this.count(v.item)<v.quantity)return '商品不足，先制作一些吧';return '';}
  trade(slot){const error=this.tradeError(slot);if(error)return error;const index=this.visitors.findIndex(v=>v.slot===slot),v=this.visitors[index];this.inventory[v.item]-=v.quantity;this.coins+=v.reward;this.reputation++;this.trades++;this.visitors.splice(index,1);this.refreshQuests();this.onChange();this.onNotice(`交易成功！金币 +${v.reward} · 声望 +1`);return '';}
  tick(dt){
    this.syncClock();
    if(!Number.isFinite(dt)||dt<=0)return;this.elapsed+=dt;let budget=dt,dirty=false;
    if(this.construction){this.construction.remaining-=dt;if(this.construction.remaining<=0){this.tiles.add(this.construction.cell);this.construction=null;this.questStats.expanded++;dirty=true;this.onNotice('便已完成扩建，新平台可以使用了！');}}
    while(this.queue.length&&budget>0){const task=this.queue[0],spent=Math.min(budget,task.remaining);task.remaining-=spent;budget-=spent;if(task.remaining<=1e-7){const r=this.recipes[task.recipe];this.inventory[r.output]=this.count(r.output)+r.amount;this.queue.shift();this.questStats.crafted+=r.amount;dirty=true;this.onNotice(`${this.items[r.output].name} 制作完成`);}}
    for(const v of this.visitors){v.remaining-=dt;v.age+=dt;}const n=this.visitors.length;this.visitors=this.visitors.filter(v=>v.remaining>0);dirty ||= n!==this.visitors.length;
    this.clock+=dt;if(this.clock>=this.settings.arrival_seconds){this.clock%=this.settings.arrival_seconds;this.spawnVisitor();}
    if(dirty)this.onChange();
  }
  atSea(){return this.voyageUntil>0;}
  syncClock(now=Date.now(),rng=Math.random){
    let dirty=this.syncEmployees(now,rng);dirty=this.refreshQuests(now,rng)||dirty;
    const h=this.housing,step=this.settings.dormitory_xp_seconds*1000;
    if(h.dorm&&this.companion.level<this.settings.companion.max_level){
      if(now<h.trainedAt){h.trainedAt=now;dirty=true;}
      const total=h.progress+Math.max(0,now-h.trainedAt),points=Math.floor(total/step);
      if(points>0){h.progress=total%step;h.trainedAt=now;this.addCompanionXp(points);if(this.companion.level===this.settings.companion.max_level)h.progress=0;dirty=true;}
    }
    if(now<this.staminaAt)this.staminaAt=now;
    if(this.stamina<this.settings.max_stamina){const step=this.settings.stamina_regen_seconds*1000,n=Math.floor((now-this.staminaAt)/step);if(n>0){this.stamina=Math.min(this.settings.max_stamina,this.stamina+n);this.staminaAt=this.stamina===this.settings.max_stamina?now:this.staminaAt+n*step;dirty=true;}}
    if(this.voyageUntil&&now>=this.voyageUntil){this.voyageUntil=0;dirty=true;this.onNotice('本次航行结束，奶蛙已安全返航');}
    if(dirty)this.onChange();
  }
  beginVoyage(now=Date.now()){
    this.syncClock(now);if(this.atSea())return '已经在海上';if(this.stamina<this.settings.voyage_stamina_cost)return '体力不足：每小时恢复 1 点，或吃一份猪脚饭恢复 2 点';
    if(this.stamina===this.settings.max_stamina)this.staminaAt=now;
    this.stamina-=this.settings.voyage_stamina_cost;this.voyageUntil=now+this.settings.voyage_seconds*1000;this.salvageUntil=0;this.questStats.voyages++;this.onChange();return '';
  }
  returnHome(){if(!this.atSea())return;this.voyageUntil=0;this.onChange();this.onNotice('奶蛙已返航，本次航行不会退还体力');}
  eatError(){if(this.stamina>=this.settings.max_stamina)return '体力已满，无需吃饭';if(this.count('pork_rice')<1)return '背包里没有猪脚饭';return '';}
  eatFood(now=Date.now()){this.syncClock(now);const error=this.eatError();if(error)return error;const gain=Math.min(this.settings.food_stamina_restore,this.settings.max_stamina-this.stamina);this.inventory.pork_rice--;this.stamina+=gain;if(this.stamina===this.settings.max_stamina)this.staminaAt=now;this.onChange();this.onNotice(`奶蛙吃了一份猪脚饭，体力 +${gain}`);return '';}
  salvageError(now=Date.now()){if(!this.atSea())return '先出海再打捞';if(now<this.salvageUntil)return `打捞准备中 · ${Math.ceil((this.salvageUntil-now)/1000)} 秒`;if(this.rawTotal()>=this.capacity())return '原料仓已满，返航制作或扩建仓库吧';return '';}
  companionXpNeeded(level=this.companion.level){const c=this.settings.companion;return c.xp_base+(level-1)*c.xp_step;}
  companionBonuses(level=this.companion.level){const c=this.settings.companion;return {quantity:level*c.quantity_percent,fine:c.fine_base+level*c.fine_step,rare:c.rare_base+level*c.rare_step};}
  setCompanion(equipped,now=Date.now()){this.syncClock(now);if(this.atSea())return '返航后再调整同行伙伴';if(typeof equipped!=='boolean')return '伙伴状态无效';if(equipped)this.leaveHousing(now);this.companion.equipped=equipped;this.onChange();return '';}
  gainCompanionXp(){if(this.companion.equipped)this.addCompanionXp(1);}
  addCompanionXp(amount){const c=this.companion;if(!positive(amount)||c.level>=this.settings.companion.max_level)return;c.xp+=amount;while(c.level<this.settings.companion.max_level&&c.xp>=this.companionXpNeeded()){c.xp-=this.companionXpNeeded();c.level++;this.onNotice(`樾升到 Lv.${c.level}，数量和品质加成提升！`);}if(c.level===this.settings.companion.max_level)c.xp=0;}
  dormitories(){return Object.entries(this.structures).filter(([,b])=>b.id==='dormitory').map(([k])=>k);}
  housingError(dorm){if(this.atSea())return '返航后调整住宿';if(this.structures[dorm]?.id!=='dormitory')return '先在岛上建造宿舍';if(this.housing.dorm===dorm)return '樾已经住在这栋宿舍';return '';}
  houseCompanion(dorm,now=Date.now()){this.syncClock(now);const error=this.housingError(dorm);if(error)return error;this.leaveHousing(now);this.companion.equipped=false;this.housing.dorm=dorm;this.housing.trainedAt=now;this.onChange();this.onNotice('樾已入住宿舍，每 30 分钟获得 1 点经验，离线也成长');return '';}
  leaveHousing(now){const h=this.housing;if(h.dorm){h.progress=this.companion.level>=this.settings.companion.max_level?0:(h.progress+Math.max(0,now-h.trainedAt))%(this.settings.dormitory_xp_seconds*1000);h.dorm=null;h.trainedAt=0;}}
  unhouseCompanion(now=Date.now()){this.syncClock(now);if(this.atSea())return '返航后调整住宿';if(!this.housing.dorm)return '樾尚未入住';this.leaveHousing(now);this.onChange();return '';}
  housingSecondsRemaining(now=Date.now()){if(!this.housing.dorm||this.companion.level>=this.settings.companion.max_level)return 0;const step=this.settings.dormitory_xp_seconds*1000;return Math.max(0,Math.ceil((step-this.housing.progress-Math.max(0,now-this.housing.trainedAt))/1000));}
  salvage(now=Date.now(),rng=Math.random){
    this.syncClock(now);const error=this.salvageError(now);if(error)return {error};
    const table=this.settings.salvage_loot,total=table.reduce((n,l)=>n+l.weight,0);let pick=rng()*total,loot=table.at(-1);
    for(const row of table){pick-=row.weight;if(pick<0){loot=row;break;}}
    let item=loot.item,quantity=loot.min+Math.floor(rng()*(loot.max-loot.min+1));
    if(this.companion.equipped){const b=this.companionBonuses(),expected=quantity*(1+b.quantity/100),base=Math.floor(expected);quantity=base+(rng()<expected-base?1:0);const quality=rng()*100;if(quality<b.rare)item='rare_cargo';else if(quality<b.rare+b.fine)item='fine_cargo';}
    const amount=this.collect(item,quantity);if(!amount)return {error:'原料仓已满'};
    this.salvageUntil=now+this.settings.salvage_seconds*1000;this.questStats.salvages++;this.gainCompanionXp();this.onChange();return {item,amount,error:''};
  }
  snapshot(){return structuredClone({version:1,landmarks:this.landmarks,questStats:this.questStats,questBoards:this.questBoards,employeeMeals:this.employeeMeals,employeeJobs:this.employeeJobs,employees:this.employees,housing:this.housing,construction:this.construction,companion:this.companion,stamina:this.stamina,staminaAt:this.staminaAt,voyageUntil:this.voyageUntil,salvageUntil:this.salvageUntil,inventory:this.inventory,coins:this.coins,reputation:this.reputation,trades:this.trades,gathered:this.gathered,tiles:[...this.tiles],structures:this.structures,queue:this.queue,visitors:this.visitors,clock:this.clock,nextVisitor:this.nextVisitor,elapsed:this.elapsed});}
  restore(data){
    try{
      if(!data||data.version!==1||!data.inventory||typeof data.inventory!=='object')throw Error();
      const copy=structuredClone(data);for(const id of Object.keys(this.items))copy.inventory[id]??=0;
      if(!copy.structures||typeof copy.structures!=='object'||Array.isArray(copy.structures))throw Error();
      const legacyLayout=copy.landmarks===undefined||Object.values(copy.structures).some(structure=>structure?.id==='shop');
      for(const [k,structure]of Object.entries(copy.structures))if(structure?.id==='shop')delete copy.structures[k];
      const restoredDockCapacity=Object.values(copy.structures).filter(row=>row.id==='dock').length;
      const companion=data.companion??{level:1,xp:0,equipped:true};
      if(!companion||!positive(companion.level)||companion.level>this.settings.companion.max_level||!nonnegative(companion.xp)||companion.xp>=this.companionXpNeeded(companion.level)||typeof companion.equipped!=='boolean'||(companion.level===this.settings.companion.max_level&&companion.xp!==0))throw Error();
      const stamina=data.stamina??this.settings.max_stamina,staminaAt=data.staminaAt??Date.now(),voyageUntil=data.voyageUntil??0,salvageUntil=data.salvageUntil??0;
      if(!nonnegative(stamina)||stamina>this.settings.max_stamina||!Number.isFinite(staminaAt)||staminaAt<0||!Number.isFinite(voyageUntil)||voyageUntil<0||!Number.isFinite(salvageUntil)||salvageUntil<0)throw Error();
      for(const [id,n]of Object.entries(data.inventory))if(!this.items[id]||!nonnegative(n))throw Error();
      for(const p of ['coins','reputation','trades','gathered','nextVisitor'])if(!nonnegative(data[p]))throw Error();
      for(const p of ['clock','elapsed'])if(!Number.isFinite(data[p])||data[p]<0)throw Error();
      if(!Array.isArray(data.tiles)||!data.tiles.length||data.tiles.length>289||new Set(data.tiles).size!==data.tiles.length)throw Error();
      for(const k of data.tiles){if(typeof k!=='string'||!/^(-?\d+),(-?\d+)$/.test(k)||cell(k).some(n=>Math.abs(n)>this.settings.max_grid_radius))throw Error();}
      const tiles=new Set(data.tiles),seen=new Set([data.tiles[0]]),front=[data.tiles[0]];for(let i=0;i<front.length;i++){const[x,z]=cell(front[i]);for(const[dx,dz]of directions){const k=key(x+dx,z+dz);if(tiles.has(k)&&!seen.has(k)){seen.add(k);front.push(k);}}}if(seen.size!==tiles.size)throw Error();
      const construction=data.construction??null;
      if(construction!==null&&(typeof construction!=='object'||Array.isArray(construction)))throw Error();
      if(construction){const k=construction.cell;if(typeof k!=='string'||!/^(-?\d+),(-?\d+)$/.test(k)||tiles.has(k)||cell(k).some(n=>Math.abs(n)>this.settings.max_grid_radius)||!tiles.has(construction.from)||!Number.isFinite(construction.remaining)||construction.remaining<=0||construction.remaining>this.settings.construction_seconds)throw Error();const[x,z]=cell(k),[a,b]=cell(construction.from);if(Math.abs(x-a)+Math.abs(z-b)!==1)throw Error();for(const[p,s]of Object.entries(copy.structures)){if(s.id!=='dock')continue;const[dx,dz]=cell(p);if(!directions.some(([ox,oz])=>!tiles.has(key(dx+ox,dz+oz))&&key(dx+ox,dz+oz)!==k))throw Error();}}
      for(const [k,b]of Object.entries(copy.structures)){if(!tiles.has(k)||!this.buildings[b.id]||!nonnegative(b.rotation)||b.rotation>3)throw Error();if(b.id==='dock'){const[x,z]=cell(k);if(!directions.some(([dx,dz])=>!tiles.has(key(x+dx,z+dz))))throw Error();}}
      const defaults={food_supplier:'1,-1',renbo:'-2,0',chaorui:'2,0',muscle_frog:'-2,-1',zihao:'2,1',haozi:'1,2',bian:'-1,1',flag:'-2,-2'},landmarks=structuredClone(copy.landmarks??defaults);
      if(!landmarks||typeof landmarks!=='object'||Array.isArray(landmarks)||Object.keys(landmarks).some(id=>!Object.hasOwn(defaults,id)))throw Error();
      const occupied=new Set(Object.keys(copy.structures));for(const id of Object.keys(defaults)){let target=landmarks[id]??defaults[id];if(copy.landmarks!==undefined&&(typeof target!=='string'||!tiles.has(target)))throw Error();if(!tiles.has(target)||occupied.has(target))target=[...tiles].find(k=>!occupied.has(k));if(!target)throw Error();landmarks[id]=target;occupied.add(target);}
      const housing=data.housing??{dorm:null,trainedAt:0,progress:0};
      if(!housing||typeof housing!=='object'||Array.isArray(housing)||!Number.isFinite(housing.trainedAt)||housing.trainedAt<0||!Number.isFinite(housing.progress)||housing.progress<0||housing.progress>=this.settings.dormitory_xp_seconds*1000||(housing.dorm!==null&&(typeof housing.dorm!=='string'||copy.structures[housing.dorm]?.id!=='dormitory'||companion.equipped)))throw Error();
      const employees=structuredClone(data.employees??Object.fromEntries(Object.keys(this.settings.employees||{}).map(id=>[id,[]])));
      if(!employees||typeof employees!=='object'||Array.isArray(employees)||Object.keys(employees).some(id=>!this.settings.employees[id]))throw Error();
      for(const [id,config]of Object.entries(this.settings.employees||{})){const timers=employees[id]??[];if(!Array.isArray(timers)||timers.length>config.max||timers.some(value=>!Number.isFinite(value)||value<0))throw Error();employees[id]=timers;}
      const restoreNow=Date.now(),employeeMeals=structuredClone(data.employeeMeals??Object.fromEntries(Object.keys(this.settings.employees).map(id=>[id,employees[id].map(()=>restoreNow+this.settings.employee_meal_seconds*1000)])));
      if(!employeeMeals||typeof employeeMeals!=='object'||Array.isArray(employeeMeals)||Object.keys(employeeMeals).some(id=>!this.settings.employees[id]))throw Error();
      for(const id of Object.keys(this.settings.employees)){const meals=employeeMeals[id]??[];if(!Array.isArray(meals)||meals.length!==employees[id].length||meals.some(value=>!Number.isFinite(value)||value<0))throw Error();employeeMeals[id]=meals;}
      const employeeJobs=structuredClone(data.employeeJobs??{haozi:employees.haozi.map(()=>null)}),jobSlots=new Set();
      if(!employeeJobs||typeof employeeJobs!=='object'||Array.isArray(employeeJobs)||Object.keys(employeeJobs).some(id=>id!=='haozi')||!Array.isArray(employeeJobs.haozi)||employeeJobs.haozi.length!==employees.haozi.length)throw Error();
      if(legacyLayout)employeeJobs.haozi=employeeJobs.haozi.map(job=>{if(!job||job.slot<restoredDockCapacity)return job;const recipe=this.recipes[job.recipe];if(recipe)for(const[id,amount]of Object.entries(recipe.cost))copy.inventory[id]=(copy.inventory[id]||0)+amount;return null;});
      for(const job of employeeJobs.haozi){if(job===null)continue;if(typeof job!=='object'||Array.isArray(job)||!this.recipes[job.recipe]||!nonnegative(job.slot)||job.slot>=restoredDockCapacity||jobSlots.has(job.slot)||!Number.isFinite(job.completeAt)||job.completeAt<0||!Number.isFinite(job.remaining)||job.remaining<0||((job.completeAt>0)===(job.remaining>0)))throw Error();jobSlots.add(job.slot);}
      const questStats=structuredClone(data.questStats??{voyages:0,salvages:0,gathered:0,expanded:0,built:0,crafted:0}),statKeys=['voyages','salvages','gathered','expanded','built','crafted'];
      if(!questStats||typeof questStats!=='object'||Array.isArray(questStats)||Object.keys(questStats).some(id=>!statKeys.includes(id))||statKeys.some(id=>!nonnegative(questStats[id])))throw Error();
      const questBoards=structuredClone(data.questBoards??{renbo:{refreshedAt:0,serial:0,tasks:[]},chaorui:{refreshedAt:0,serial:0,tasks:[]}}),questIds=new Set();
      if(!questBoards||typeof questBoards!=='object'||Array.isArray(questBoards)||Object.keys(questBoards).some(id=>!this.settings.quests.boards[id]))throw Error();
      for(const [id,templates]of Object.entries(this.settings.quests.boards)){const board=questBoards[id]??{refreshedAt:0,serial:0,tasks:[]};if(!board||typeof board!=='object'||Array.isArray(board)||!Number.isFinite(board.refreshedAt)||board.refreshedAt<0||!nonnegative(board.serial)||!Array.isArray(board.tasks)||board.tasks.length>this.settings.quests.max_per_board)throw Error();for(const task of board.tasks){const template=templates.find(row=>row.kind===task.kind&&row.metric===task.metric);if(!template||typeof task.id!=='string'||!task.id.startsWith(`${id}-`)||questIds.has(task.id)||task.name!==template.name||task.unit!==template.unit||!positive(task.goal)||task.goal<template.min||task.goal>template.max||!nonnegative(task.start))throw Error();questIds.add(task.id);}questBoards[id]=board;}
      if(!Array.isArray(data.queue)||data.queue.length>this.settings.queue_limit)throw Error();for(const t of data.queue)if(!this.recipes[t.recipe]||!Number.isFinite(t.remaining)||t.remaining<=0||t.remaining>this.recipes[t.recipe].seconds)throw Error();
      if(!Array.isArray(copy.visitors))throw Error();copy.visitors=copy.visitors.slice(0,restoredDockCapacity).map((visitor,slot)=>({...visitor,slot}));const slots=new Set();for(const v of copy.visitors){if(!this.npcs[v.npc]||!this.items[v.item]||!positive(v.quantity)||!positive(v.reward)||!nonnegative(v.slot)||v.slot>=restoredDockCapacity||slots.has(v.slot)||!Number.isFinite(v.remaining)||v.remaining<=0||!Number.isFinite(v.age)||v.age<0)throw Error();slots.add(v.slot);}
      this.companion=structuredClone(companion);
      this.housing=structuredClone(housing);
      this.employees=structuredClone(employees);
      this.employeeMeals=structuredClone(employeeMeals);
      this.employeeJobs=structuredClone(employeeJobs);
      this.questStats=structuredClone(questStats);
      this.questBoards=structuredClone(questBoards);
      this.construction=structuredClone(construction);
      this.landmarks=structuredClone(landmarks);
      for(const p of ['inventory','coins','reputation','trades','gathered','structures','queue','visitors','clock','nextVisitor','elapsed'])this[p]=copy[p];this.tiles=tiles;this.stamina=stamina;this.staminaAt=staminaAt;this.voyageUntil=voyageUntil;this.salvageUntil=salvageUntil;this.syncClock();this.onChange();return '';
    }catch{return '存档无法读取，原文件已保留。可下载备份后开始新局。';}
  }
}
