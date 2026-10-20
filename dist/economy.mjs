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
    this.landmarks={food_supplier:'1,-1',renbo:'-2,0',chaorui:'2,0',muscle_frog:'-2,-1',zihao:'2,1',haozi:'1,2',bian:'-1,1',feidudu:'0,-2',flag:'-2,-2'};
    this.queue=[]; this.visitors=[]; this.clock=0; this.nextVisitor=0; this.elapsed=0;
    this.stamina=this.settings.max_stamina;this.staminaAt=Date.now();this.voyageUntil=0;this.salvageUntil=0;this.voyageRoute=this.settings.voyage_routes?.[0]?.id||'coast';this.voyageSupplies={salvage_net:false,current_compass:false};this.activeVoyageSupplies={salvage_net:false,current_compass:false};this.cargoCrateUpgrades=0;
    this.companion={level:1,xp:0,equipped:true};
    this.housing={dorm:null,trainedAt:0,progress:0};
    this.employees={zihao:[],haozi:[]};
    this.employeeContracts={zihao:0,haozi:0};
    this.employeeMeals={zihao:[],haozi:[]};
    this.employeeJobs={haozi:[]};
    this.employeePaused={zihao:false,haozi:false};
    this.employeePausedAt={zihao:0,haozi:0};
    this.wanderer=null;this.wandererClock=0;
    this.deliveryTask=null;
    this.warehousePolicies=Object.fromEntries(this.settings.delivery_trader.items.map(row=>[row.item,{min:0,max:null}]));
    this.questStats={voyages:0,salvages:0,gathered:0,expanded:0,built:0,crafted:0};
    this.questBoards={renbo:{refreshedAt:0,serial:0,tasks:[]},chaorui:{refreshedAt:0,serial:0,tasks:[]}};
    this.orderStreak=0;this.bestOrderStreak=0;this.developmentClaims=[];
    this.arcade={tide_match:{availableAt:0,plays:0,bestMoves:null,bestSeconds:null}};
    this.construction=null;
    this.spawnVisitor();this.onChange();
  }
  count(id){return this.inventory[id]||0;}
  has(id){return Object.values(this.structures).some(b=>b.id===id);}
  capacity(){return this.settings.base_capacity+Object.values(this.structures).filter(b=>b.id==='warehouse').length*this.settings.warehouse_capacity+this.cargoCrateUpgrades*(this.settings.cargo_crate_capacity||0);}
  rawTotal(){return Object.values(this.items).filter(i=>i.kind==='resource').reduce((n,i)=>n+this.count(i.id),0);}
  deliveryReservedRaw(){return this.deliveryTask?Object.values(this.deliveryTask.buy).reduce((n,amount)=>n+amount,0):0;}
  rawCommittedTotal(){return this.rawTotal()+this.deliveryReservedRaw();}
  afford(cost,coins=0){return this.coins>=coins&&Object.entries(cost).every(([id,n])=>this.count(id)>=n);}
  spend(cost,coins=0){for(const [id,n]of Object.entries(cost))this.inventory[id]=this.count(id)-n;this.coins-=coins;}
  collect(id,n=2){
    this.syncClock();if(!this.atSea()){this.onNotice('先出海，才能打捞物资');return 0;}
    if(!this.items[id]||!positive(n))return 0;
    const amount=this.items[id].kind==='resource'?Math.min(n,Math.max(0,this.capacity()-this.rawCommittedTotal())):n;
    if(!amount){this.onNotice('原料仓已满，制作道具或建造仓库可腾出空间');return 0;}
    this.inventory[id]=this.count(id)+amount;this.gathered+=amount;this.questStats.gathered+=amount;this.onChange();return amount;
  }
  productionQueueLimit(){return this.settings.queue_limit+this.employeeCount('haozi');}
  craftError(id){const r=this.recipes[id];if(!r)return '配方不存在';if(this.atSea())return '返航后安排制作';if(!this.has('workshop'))return '先在浮岛上建造加工台';if(this.reputation<r.reputation)return `声望 ${r.reputation} 解锁`;if(this.queue.length>=this.productionQueueLimit())return '制作队列已满';if(!this.afford(r.cost))return '材料不足，出海打捞，或找供应商买饭吧';return '';}
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
  purchaseError(vendorId,index=0){const offer=this.vendors[vendorId]?.offers[index];if(!offer)return '商品不存在';if(this.atSea())return '返航后购买';if(this.coins<offer.price)return '金币不足，先完成一些订单吧';if(!this.has('workshop')&&this.coins-offer.price<this.buildings.workshop.coins)return '先留够建造加工台的金币，再来买饭吧';if(this.items[offer.item].kind==='resource'&&this.rawCommittedTotal()+offer.quantity>this.capacity())return '原料仓容量不足';return '';}
  buy(vendorId,index=0){const error=this.purchaseError(vendorId,index);if(error)return error;const offer=this.vendors[vendorId].offers[index];this.coins-=offer.price;this.inventory[offer.item]=this.count(offer.item)+offer.quantity;this.onChange();this.onNotice(`购买成功：${this.items[offer.item].name} +${offer.quantity}`);return '';}
  warehouseFloor(id){return this.warehousePolicies[id]?.min||0;}
  employeeAvailable(id){return Math.max(0,this.count(id)-this.warehouseFloor(id));}
  employeeAfford(cost){return Object.entries(cost).every(([id,amount])=>this.employeeAvailable(id)>=amount);}
  voyageRouteConfig(id=this.voyageRoute){return this.settings.voyage_routes?.find(route=>route.id===id)||null;}
  voyageRouteError(id){const route=this.voyageRouteConfig(id);if(!route)return '航线不存在';if(this.reputation<route.reputation)return `声望 ${route.reputation} 解锁${route.name}`;if(this.stamina<route.stamina)return `体力不足：${route.name}需要 ${route.stamina} 点体力`;return '';}
  setVoyageSupply(id,equipped){if(this.atSea())return '返航后再调整航行装备';if(!Object.hasOwn(this.voyageSupplies,id)||typeof equipped!=='boolean')return '航行装备无效';if(equipped&&this.count(id)<1)return `仓库里没有${this.items[id].name}`;this.voyageSupplies[id]=equipped;this.onChange();return '';}
  cargoCrateError(){if(this.atSea())return '返航后才能加固仓库';if(this.reputation<this.recipes.cargo_crate.reputation)return `声望 ${this.recipes.cargo_crate.reputation} 解锁加固货箱`;if(this.cargoCrateUpgrades>=this.settings.cargo_crate_max)return '加固货箱已达到升级上限';if(this.count('cargo_crate')<1)return '先在加工台制作加固货箱';return '';}
  useCargoCrate(){const error=this.cargoCrateError();if(error)return error;this.inventory.cargo_crate--;this.cargoCrateUpgrades++;this.onChange();this.onNotice(`仓库加固完成：永久容量 +${this.settings.cargo_crate_capacity}`);return '';}
  buildingCount(id){return Object.values(this.structures).filter(building=>building.id===id).length;}
  developmentRequirementValue(requirement){if(requirement.type==='building')return this.buildingCount(requirement.id);if(requirement.type==='trades')return this.trades;if(requirement.type==='reputation')return this.reputation;if(requirement.type==='employees')return Object.keys(this.settings.employees).reduce((total,id)=>total+this.employeeCount(id),0);if(requirement.type==='companion_level')return this.companion.level;return 0;}
  developmentMilestone(id){return this.settings.development_milestones?.find(row=>row.id===id)||null;}
  developmentReady(id){const milestone=this.developmentMilestone(id);return Boolean(milestone)&&milestone.requirements.every(requirement=>this.developmentRequirementValue(requirement)>=requirement.goal);}
  claimDevelopment(id){const milestone=this.developmentMilestone(id);if(!milestone)return '发展目标不存在';if(this.developmentClaims.includes(id))return '该发展奖励已经领取';if(!this.developmentReady(id))return '发展目标尚未完成';this.coins+=milestone.reward.coins||0;for(const[item,amount]of Object.entries(milestone.reward))if(item!=='coins')this.inventory[item]=this.count(item)+amount;this.developmentClaims.push(id);this.onChange();this.onNotice(`发展目标完成：${milestone.name} · ${this.rewardText(milestone.reward)}`);return '';}
  rewardText(reward){return Object.entries(reward).map(([id,amount])=>id==='coins'?`金币 +${amount}`:`${this.items[id].name} +${amount}`).join(' · ');}
  advanceOrderStreak(){this.orderStreak++;this.bestOrderStreak=Math.max(this.bestOrderStreak,this.orderStreak);const config=this.settings.order_streak;if(!config||this.orderStreak%config.step)return 0;const tier=this.orderStreak/config.step,bonus=Math.min(config.max_bonus,config.base_bonus+(tier-1)*config.bonus_step);this.coins+=bonus;return bonus;}
  tideMatchError(now=Date.now()){const config=this.settings.minigames?.tide_match,state=this.arcade.tide_match;if(!config)return '潮汐配对尚未开放';if(this.atSea())return '返航后才能参加潮汐配对';if(this.reputation<config.reputation)return `声望 ${config.reputation} 解锁潮汐配对`;if(now<state.availableAt)return `潮汐配对准备中 · ${Math.ceil((state.availableAt-now)/1000)} 秒`;return '';}
  tideMatchSecondsRemaining(now=Date.now()){return Math.max(0,Math.ceil((this.arcade.tide_match.availableAt-now)/1000));}
  completeTideMatch(moves,seconds,now=Date.now(),rng=Math.random){const error=this.tideMatchError(now);if(error)return {error};const config=this.settings.minigames.tide_match,state=this.arcade.tide_match;if(!positive(moves)||moves<config.pairs||!Number.isFinite(seconds)||seconds<=0||seconds>3600)return {error:'潮汐配对成绩无效'};let coins=config.base_coins;if(moves<=config.perfect_moves)coins+=config.perfect_bonus;else if(moves<=config.efficient_moves)coins+=config.efficient_bonus;if(seconds<=config.fast_seconds)coins+=config.fast_bonus;else if(seconds<=config.steady_seconds)coins+=config.steady_bonus;const lootTable=this.settings.salvage_loot,item=lootTable[Math.min(lootTable.length-1,Math.floor(rng()*lootTable.length))].item,rolled=config.material_min+Math.floor(rng()*(config.material_max-config.material_min+1)),amount=Math.min(rolled,Math.max(0,this.capacity()-this.rawCommittedTotal()));this.coins+=coins;if(amount)this.inventory[item]=this.count(item)+amount;else coins+=5,this.coins+=5;state.availableAt=now+config.cooldown_seconds*1000;state.plays++;state.bestMoves=state.bestMoves===null?moves:Math.min(state.bestMoves,moves);state.bestSeconds=state.bestSeconds===null?seconds:Math.min(state.bestSeconds,seconds);this.onChange();const reward={coins,item:amount?item:null,amount};this.onNotice(`潮汐配对完成：${this.rewardText({coins,...(amount?{[item]:amount}:{})})}`);return {error:'',reward};}
  warehousePolicyError(policies){
    const allowed=new Set(this.settings.delivery_trader.items.map(row=>row.item));if(!policies||typeof policies!=='object'||Array.isArray(policies)||Object.keys(policies).some(id=>!allowed.has(id)))return '仓库策略无效';for(const id of allowed){const policy=policies[id];if(!policy||!nonnegative(policy.min)||(policy.max!==null&&!nonnegative(policy.max))||(policy.max!==null&&policy.max<policy.min))return `${this.items[id].name}的底线或上限无效`;}return '';
  }
  setWarehousePolicies(policies,now=Date.now(),rng=Math.random){const error=this.warehousePolicyError(policies);if(error)return error;this.syncDelivery(now);this.warehousePolicies=structuredClone(policies);const started=this.syncWarehouseAutoSell(now,rng);this.onChange();if(!started)this.onNotice('仓库策略已保存');return '';}
  deliverySummary(buy={},sell={}){
    const config=this.settings.delivery_trader,lines=config.items,buyCost=lines.reduce((n,row)=>n+(buy[row.item]||0)*row.buy_price,0),sellRevenue=lines.reduce((n,row)=>n+(sell[row.item]||0)*row.sell_price,0),buyTotal=lines.reduce((n,row)=>n+(buy[row.item]||0),0),sellTotal=lines.reduce((n,row)=>n+(sell[row.item]||0),0);
    return {buyCost,sellRevenue,buyTotal,sellTotal,coinCharge:Math.max(0,buyCost-sellRevenue),coinPayout:Math.max(0,sellRevenue-buyCost)};
  }
  deliveryTradeError(buy={},sell={}){
    const config=this.settings.delivery_trader;if(!config)return '配送交易尚未开放';if(this.atSea())return '返航后才能提交配送任务';if(this.deliveryTask)return '肥嘟嘟正在配送中';
    const allowed=new Set(config.items.map(row=>row.item));for(const plan of [buy,sell]){if(!plan||typeof plan!=='object'||Array.isArray(plan)||Object.keys(plan).some(id=>!allowed.has(id))||Object.values(plan).some(amount=>!nonnegative(amount)))return '物资数量无效';}
    const summary=this.deliverySummary(buy,sell);if(!summary.buyTotal&&!summary.sellTotal)return '请先填写购买或售卖数量';for(const row of config.items)if((sell[row.item]||0)>this.count(row.item))return `${this.items[row.item].name}库存不足`;if(this.coins<summary.coinCharge)return `金币不足，还需要 ${summary.coinCharge-this.coins} 金币`;
    if(this.rawCommittedTotal()-summary.sellTotal+summary.buyTotal>this.capacity())return '配送完成后会超过原料仓容量';return '';
  }
  startDeliveryTrade(buy,sell,now,rng,automatic=false){const cleanBuy={},cleanSell={};for(const row of this.settings.delivery_trader.items){cleanBuy[row.item]=buy[row.item]||0;cleanSell[row.item]=sell[row.item]||0;this.inventory[row.item]-=cleanSell[row.item];}const summary=this.deliverySummary(cleanBuy,cleanSell),min=this.settings.delivery_trader.delivery_min_seconds,max=this.settings.delivery_trader.delivery_max_seconds,duration=min+Math.floor(rng()*(max-min+1));this.coins-=summary.coinCharge;this.deliveryTask={buy:cleanBuy,sell:cleanSell,...summary,duration,completeAt:now+duration*1000,automatic};return duration;}
  submitDeliveryTrade(buy={},sell={},now=Date.now(),rng=Math.random){this.syncClock(now,rng);const error=this.deliveryTradeError(buy,sell);if(error)return error;const duration=this.startDeliveryTrade(buy,sell,now,rng,false);this.onChange();this.onNotice(`肥嘟嘟已接单，预计 ${Math.ceil(duration/60)} 分钟送达`);return '';}
  deliverySecondsRemaining(now=Date.now()){return this.deliveryTask?Math.max(0,Math.ceil((this.deliveryTask.completeAt-now)/1000)):0;}
  syncDelivery(now=Date.now()){
    const task=this.deliveryTask;if(!task||now<task.completeAt)return false;for(const[id,amount]of Object.entries(task.buy))this.inventory[id]=this.count(id)+amount;this.coins+=task.coinPayout;this.deliveryTask=null;this.onNotice(`肥嘟嘟配送完成${task.coinPayout?` · 金币 +${task.coinPayout}`:''}`);return true;
  }
  syncWarehouseAutoSell(now=Date.now(),rng=Math.random){if(this.deliveryTask)return false;const sell={};for(const row of this.settings.delivery_trader.items){const max=this.warehousePolicies[row.item]?.max;sell[row.item]=max===null||max===undefined?0:Math.max(0,this.count(row.item)-max);}if(!Object.values(sell).some(Boolean))return false;const duration=this.startDeliveryTrade({},sell,now,rng,true);this.onNotice(`资源超过仓库上限，肥嘟嘟已自动接取售卖配送 · ${Math.ceil(duration/60)} 分钟`);return true;}
  employeeCount(id){return this.employees[id]?.length||0;}
  contractEmployeeCount(id){return this.employeeContracts[id]||0;}
  regularEmployeeCount(id){return Math.max(0,this.employeeCount(id)-this.contractEmployeeCount(id));}
  hireEmployeeError(id){const config=this.settings.employees?.[id];if(!config)return '员工不存在';if(this.atSea())return '返航后才能招募员工';if(this.regularEmployeeCount(id)>=config.max)return `${config.name}已达到普通招募上限`;if(this.coins<config.price)return `金币不足，还需要 ${config.price-this.coins} 金币`;return '';}
  addEmployee(id,now=Date.now(),contract=false){const config=this.settings.employees[id];this.employees[id].push(now+(config.voyage_seconds||0)*1000);this.employeeMeals[id].push(now+this.settings.employee_meal_seconds*1000);if(id==='haozi')this.employeeJobs.haozi.push(null);if(contract)this.employeeContracts[id]++;}
  hireEmployee(id,now=Date.now()){
    this.syncClock(now);const error=this.hireEmployeeError(id);if(error)return error;const config=this.settings.employees[id];
    this.coins-=config.price;this.addEmployee(id,now,false);this.onChange();this.onNotice(id==='zihao'?'招募成功：自豪 ×1，船队将在 5 分钟后带回物资':'招募成功：豪自 ×1，生产队列 +1，并自动处理码头订单');return '';
  }
  employeeSecondsRemaining(id,now=Date.now()){const timers=this.employees[id]||[],reference=this.employeePaused[id]?this.employeePausedAt[id]:now;return timers.length?Math.max(0,Math.ceil((Math.min(...timers)-reference)/1000)):0;}
  employeeMealSecondsRemaining(id,now=Date.now()){const meals=this.employeeMeals[id]||[],active=meals.filter(Boolean),reference=this.employeePaused[id]?this.employeePausedAt[id]:now;return active.length?Math.max(0,Math.ceil((Math.min(...active)-reference)/1000)):0;}
  employeeWorkingCount(id){return this.employeePaused[id]?0:(this.employeeMeals[id]||[]).filter(Boolean).length;}
  setEmployeePaused(id,paused,now=Date.now()){
    if(!Object.hasOwn(this.employeePaused,id))return '员工类型不存在';if(!this.employeeCount(id))return `尚未招募${this.settings.employees[id].name}`;if(this.employeePaused[id]===paused)return '';
    this.syncClock(now);
    if(paused){this.employeePaused[id]=true;this.employeePausedAt[id]=now;}
    else{const delta=Math.max(0,now-this.employeePausedAt[id]);this.employees[id]=this.employees[id].map(timer=>timer+delta);this.employeeMeals[id]=this.employeeMeals[id].map(timer=>timer?timer+delta:0);if(id==='haozi')for(const job of this.employeeJobs.haozi)if(job?.completeAt)job.completeAt+=delta;this.employeePaused[id]=false;this.employeePausedAt[id]=0;}
    this.onChange();this.onNotice(`${this.settings.employees[id].name}${paused?'已停止工作':'已恢复工作'}`);return '';
  }
  syncEmployeeMeal(id,index,now){
    const meals=this.employeeMeals[id],step=this.settings.employee_meal_seconds*1000,due=meals[index];
    const restock=needed=>{const offer=this.vendors.food_supplier?.offers.find(row=>row.item==='pork_rice');if(!offer)return 0;const missing=Math.max(0,needed-this.count('pork_rice')),bought=Math.min(missing,Math.floor(this.coins/offer.price));if(bought){this.coins-=bought*offer.price;this.inventory.pork_rice=this.count('pork_rice')+bought;}return bought;};
    if(due===0){const bought=restock(1);if(this.count('pork_rice')<1)return {activeUntil:0,dirty:Boolean(bought),resumed:false,stopped:false,ate:0,bought};this.inventory.pork_rice--;meals[index]=now+step;return {activeUntil:now,dirty:true,resumed:true,stopped:false,ate:1,bought};}
    if(now<due)return {activeUntil:now,dirty:false,resumed:false,stopped:false,ate:0,bought:0};
    const needed=Math.floor((now-due)/step)+1,bought=restock(needed),available=Math.min(needed,this.count('pork_rice'));this.inventory.pork_rice-=available;
    if(available<needed){const activeUntil=Math.min(now,due+available*step);meals[index]=0;return {activeUntil,dirty:true,resumed:false,stopped:true,ate:available,bought};}
    meals[index]=due+available*step;return {activeUntil:now,dirty:true,resumed:false,stopped:false,ate:available,bought};
  }
  rollEmployeeLoot(rng=Math.random){const table=this.settings.salvage_loot,total=table.reduce((n,row)=>n+row.weight,0);let pick=rng()*total,loot=table.at(-1);for(const row of table){pick-=row.weight;if(pick<0){loot=row;break;}}return {item:loot.item,quantity:loot.min+Math.floor(rng()*(loot.max-loot.min+1))};}
  recipeForOrder(item,quantity,seen=new Set()){
    if(this.employeeAvailable(item)>=quantity||seen.has(item))return null;const recipe=Object.values(this.recipes).find(row=>row.output===item);if(!recipe||this.reputation<recipe.reputation)return null;seen.add(item);
    for(const [ingredient,needed]of Object.entries(recipe.cost)){if(this.employeeAvailable(ingredient)>=needed)continue;const nested=this.recipeForOrder(ingredient,needed,new Set(seen));if(nested)return nested;return null;}
    return this.employeeAfford(recipe.cost)?recipe:null;
  }
  autoTrade(slot){const index=this.visitors.findIndex(visitor=>visitor.slot===slot);if(index<0)return false;const visitor=this.visitors[index];if(visitor.age<2||this.count(visitor.item)<visitor.quantity)return false;this.inventory[visitor.item]-=visitor.quantity;this.coins+=visitor.reward;this.reputation++;this.trades++;this.visitors.splice(index,1);const bonus=this.advanceOrderStreak();this.refreshQuests();this.onNotice(`豪自完成码头订单：金币 +${visitor.reward}${bonus?` · 连单奖励 +${bonus}`:''} · 声望 +1`);return true;}
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
    let dirty=false,returns=0,stored=0,overflow=false,ate=0,autoBought=0,stopped=0,resumed=0;const rewards={},timers=this.employees.zihao||[],step=this.settings.employees.zihao.voyage_seconds*1000;
    if(!this.employeePaused.zihao)for(let i=0;i<timers.length;i++){
        const meal=this.syncEmployeeMeal('zihao',i,now);dirty=meal.dirty||dirty;ate+=meal.ate;autoBought+=meal.bought;stopped+=Number(meal.stopped);resumed+=Number(meal.resumed);if(meal.resumed)timers[i]=now+step;
        if(meal.activeUntil&&timers[i]<=meal.activeUntil){const trips=Math.floor((meal.activeUntil-timers[i])/step)+1;timers[i]+=trips*step;returns+=trips;dirty=true;
        for(let trip=0;trip<trips&&this.rawCommittedTotal()<this.capacity();trip++){
          const loot=this.rollEmployeeLoot(rng),amount=Math.min(loot.quantity,Math.max(0,this.capacity()-this.rawCommittedTotal()));
          if(amount<loot.quantity)overflow=true;if(!amount)continue;this.inventory[loot.item]=this.count(loot.item)+amount;this.gathered+=amount;rewards[loot.item]=(rewards[loot.item]||0)+amount;stored+=amount;
        }
        if(this.rawCommittedTotal()>=this.capacity())overflow=true;
        }
        if(meal.stopped)timers[i]=now+step;
    }
    const reserved=new Set(this.employeeJobs.haozi.filter(Boolean).map(job=>job.slot));
    if(!this.employeePaused.haozi)for(let i=0;i<this.employees.haozi.length;i++){
      const meal=this.syncEmployeeMeal('haozi',i,now);dirty=meal.dirty||dirty;ate+=meal.ate;autoBought+=meal.bought;stopped+=Number(meal.stopped);resumed+=Number(meal.resumed);let job=this.employeeJobs.haozi[i];
      if(meal.resumed&&job?.remaining){job.completeAt=now+job.remaining;job.remaining=0;dirty=true;}
      if(meal.activeUntil)dirty=this.syncHaoziWorker(i,meal.activeUntil,now,reserved)||dirty;job=this.employeeJobs.haozi[i];
      if(meal.stopped&&job?.completeAt>meal.activeUntil){job.remaining=job.completeAt-meal.activeUntil;job.completeAt=0;dirty=true;}
    }
    if(returns){const detail=Object.entries(rewards).map(([id,n])=>`${this.items[id].name} +${n}`).join(' · ');this.onNotice(stored?`自豪船队返航 ${returns} 次：${detail}${overflow?' · 仓库已满，部分物资未能入库':''}`:'自豪船队已返航，但原料仓已满');}
    const mealCost=this.vendors.food_supplier?.offers.find(row=>row.item==='pork_rice')?.price||0,restockNote=autoBought?` · 自动购买猪脚饭 ${autoBought} 份（-${autoBought*mealCost} 金币）`:'';if(stopped)this.onNotice(`${stopped} 名员工因金币和猪脚饭不足停止工作${restockNote}`);else if(resumed)this.onNotice(`${resumed} 名员工吃过猪脚饭，恢复工作${restockNote}`);else if(ate)this.onNotice(`员工用餐：猪脚饭 -${ate}${restockNote}`);
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
    let reward;if(rng()<.5||this.rawCommittedTotal()>=this.capacity()){const amount=rewards.coin_reward.min+Math.floor(rng()*(rewards.coin_reward.max-rewards.coin_reward.min+1));this.coins+=amount;reward={type:'coins',amount};}else{const items=this.settings.salvage_loot.map(row=>row.item),item=items[Math.floor(rng()*items.length)],rolled=rewards.material_reward.min+Math.floor(rng()*(rewards.material_reward.max-rewards.material_reward.min+1)),amount=Math.min(rolled,this.capacity()-this.rawCommittedTotal());if(amount>0){this.inventory[item]=this.count(item)+amount;reward={type:'item',item,amount};}else{const amount=rewards.coin_reward.min;this.coins+=amount;reward={type:'coins',amount};}}
    board.tasks.splice(index,1);this.onChange();const detail=reward.type==='coins'?`金币 +${reward.amount}`:`${this.items[reward.item].name} +${reward.amount}`;this.onNotice(`${boardId==='renbo'?'仁博':'晁瑞'}任务完成：${detail}`);return {error:'',reward,task};
  }
  freeDockSlots(){const occupied=new Set(this.visitors.map(visitor=>visitor.slot));if(this.wanderer)occupied.add(this.wanderer.slot);return Array.from({length:this.orderCapacity()},(_,slot)=>slot).filter(slot=>!occupied.has(slot));}
  spawnWanderer(rng=Math.random,force=false){
    const config=this.settings.wanderer,capacity=this.orderCapacity(),free=this.freeDockSlots();if(!config||this.wanderer||!capacity||(!force&&!free.length))return false;
    const pool=[...config.catalog],count=Math.min(pool.length,config.stock_min+Math.floor(rng()*(config.stock_max-config.stock_min+1))),offers=[];
    while(offers.length<count&&pool.length){const index=Math.min(pool.length-1,Math.floor(rng()*pool.length)),entry=pool.splice(index,1)[0],quantity=entry.quantity_min+Math.floor(rng()*(entry.quantity_max-entry.quantity_min+1)),price=entry.price_min+Math.floor(rng()*(entry.price_max-entry.price_min+1)),offer={item:entry.item,quantity,price,implemented:entry.implemented!==false};if(entry.employee)offer.employee=entry.employee;offers.push(offer);}
    const slots=free.length?free:Array.from({length:capacity},(_,slot)=>slot),slot=slots[Math.min(slots.length-1,Math.floor(rng()*slots.length))];if(!free.length)this.visitors=this.visitors.filter(visitor=>visitor.slot!==slot);
    this.wanderer={slot,remaining:config.visit_seconds,age:0,offers};this.wandererClock=0;this.onChange();this.onNotice('粉红蛙准时停靠码头：流浪商店营业 5 分钟');return true;
  }
  wandererPurchaseError(index){const offer=this.wanderer?.offers[index];if(!this.wanderer)return '粉红蛙已经离港';if(!offer)return '商品不存在';if(this.atSea())return '返航后才能购买';if(!offer.implemented||this.items[offer.item]?.implemented===false)return '该商品尚未实装';if(offer.employee&&!this.settings.employees[offer.employee])return '契约员工不存在';if(offer.quantity<1)return '本次库存已经售罄';if(this.coins<offer.price)return '金币不足';if(this.items[offer.item].kind==='resource'&&this.rawCommittedTotal()>=this.capacity())return '原料仓容量不足';return '';}
  buyWanderer(index,now=Date.now()){const error=this.wandererPurchaseError(index);if(error)return error;const offer=this.wanderer.offers[index];this.coins-=offer.price;offer.quantity--;if(offer.employee){this.addEmployee(offer.employee,now,true);this.onChange();this.onNotice(`从粉红蛙处签下${this.settings.employees[offer.employee].name}契约 · 不占普通招募上限${offer.employee==='haozi'?' · 生产队列 +1':''}`);return '';}this.inventory[offer.item]=this.count(offer.item)+1;this.onChange();this.onNotice(`从粉红蛙处购买：${this.items[offer.item].name} +1`);return '';}
  wandererNextSeconds(){return Math.max(0,Math.ceil(((this.settings.wanderer?.interval_seconds||600)-this.wandererClock)));}
  spawnVisitor(){
    const free=this.freeDockSlots();if(!free.length||!this.has('dock'))return;
    const ids=Object.keys(this.npcs),id=ids[this.nextVisitor++%ids.length];
    const prefs=this.npcs[id].preferences.filter(p=>(!p.requires_owned||this.count(p.item)>=p.quantity)&&!Object.values(this.recipes).some(r=>r.output===p.item&&r.reputation>this.reputation));
    if(!prefs.length)return;const p=prefs[Math.floor(Math.random()*prefs.length)],slot=free[0];
    this.visitors.push({npc:id,...p,slot,remaining:this.settings.visitor_seconds,age:0});this.onChange();
  }
  tradeError(slot){if(this.atSea())return '返航后交付订单';const v=this.visitors.find(v=>v.slot===slot);if(!v)return '顾客已离港';if(v.age<2)return '顾客正在靠岸';if(this.count(v.item)<v.quantity)return '商品不足，先制作一些吧';return '';}
  trade(slot){const error=this.tradeError(slot);if(error)return error;const index=this.visitors.findIndex(v=>v.slot===slot),v=this.visitors[index];this.inventory[v.item]-=v.quantity;this.coins+=v.reward;this.reputation++;this.trades++;this.visitors.splice(index,1);const bonus=this.advanceOrderStreak();this.refreshQuests();this.onChange();this.onNotice(`交易成功！金币 +${v.reward}${bonus?` · 连单奖励 +${bonus}`:''} · 声望 +1`);return '';}
  tick(dt){
    this.syncClock();
    if(!Number.isFinite(dt)||dt<=0)return;this.elapsed+=dt;let budget=dt,dirty=false;
    if(this.construction){this.construction.remaining-=dt;if(this.construction.remaining<=0){this.tiles.add(this.construction.cell);this.construction=null;this.questStats.expanded++;dirty=true;this.onNotice('便已完成扩建，新平台可以使用了！');}}
    while(this.queue.length&&budget>0){const task=this.queue[0],spent=Math.min(budget,task.remaining);task.remaining-=spent;budget-=spent;if(task.remaining<=1e-7){const r=this.recipes[task.recipe];this.inventory[r.output]=this.count(r.output)+r.amount;this.queue.shift();this.questStats.crafted+=r.amount;dirty=true;this.onNotice(`${this.items[r.output].name} 制作完成`);}}
    for(const v of this.visitors){v.remaining-=dt;v.age+=dt;}const n=this.visitors.length;this.visitors=this.visitors.filter(v=>v.remaining>0);if(n!==this.visitors.length){dirty=true;if(this.orderStreak){this.orderStreak=0;this.onNotice('有订单超时离港，连续交付已中断');}}
    this.wandererClock+=dt;
    if(this.wanderer){this.wanderer.remaining-=dt;this.wanderer.age+=dt;if(this.wanderer.remaining<=0){this.wanderer=null;dirty=true;this.onNotice('粉红蛙已经离开码头，5 分钟后再次出现');}}
    else{const interval=this.settings.wanderer?.interval_seconds||600;if(this.wandererClock>=interval)dirty=this.spawnWanderer(Math.random,true)||dirty;}
    this.clock+=dt;if(this.clock>=this.settings.arrival_seconds){this.clock%=this.settings.arrival_seconds;this.spawnVisitor();}
    if(dirty)this.onChange();
  }
  atSea(){return this.voyageUntil>0;}
  syncClock(now=Date.now(),rng=Math.random){
    let dirty=this.syncDelivery(now);dirty=this.syncEmployees(now,rng)||dirty;dirty=this.syncWarehouseAutoSell(now,rng)||dirty;dirty=this.refreshQuests(now,rng)||dirty;
    const h=this.housing,step=this.settings.dormitory_xp_seconds*1000;
    if(h.dorm&&this.companion.level<this.settings.companion.max_level){
      if(now<h.trainedAt){h.trainedAt=now;dirty=true;}
      const total=h.progress+Math.max(0,now-h.trainedAt),points=Math.floor(total/step);
      if(points>0){h.progress=total%step;h.trainedAt=now;this.addCompanionXp(points);if(this.companion.level===this.settings.companion.max_level)h.progress=0;dirty=true;}
    }
    if(now<this.staminaAt)this.staminaAt=now;
    if(this.stamina<this.settings.max_stamina){const step=this.settings.stamina_regen_seconds*1000,n=Math.floor((now-this.staminaAt)/step);if(n>0){this.stamina=Math.min(this.settings.max_stamina,this.stamina+n);this.staminaAt=this.stamina===this.settings.max_stamina?now:this.staminaAt+n*step;dirty=true;}}
    if(this.voyageUntil&&now>=this.voyageUntil){this.voyageUntil=0;this.activeVoyageSupplies={salvage_net:false,current_compass:false};dirty=true;this.onNotice('本次航行结束，奶蛙已安全返航');}
    if(dirty)this.onChange();
  }
  beginVoyage(routeId=this.settings.voyage_routes?.[0]?.id||'coast',now=Date.now()){
    if(typeof routeId==='number'){now=routeId;routeId=this.settings.voyage_routes?.[0]?.id||'coast';}
    this.syncClock(now);if(this.atSea())return '已经在海上';const error=this.voyageRouteError(routeId);if(error)return error;const route=this.voyageRouteConfig(routeId);
    if(this.stamina===this.settings.max_stamina)this.staminaAt=now;
    this.stamina-=route.stamina;this.voyageRoute=route.id;this.activeVoyageSupplies={salvage_net:false,current_compass:false};for(const id of Object.keys(this.voyageSupplies))if(this.voyageSupplies[id]&&this.count(id)>0){this.inventory[id]--;this.activeVoyageSupplies[id]=true;this.voyageSupplies[id]=false;}this.voyageUntil=now+route.seconds*1000;this.salvageUntil=0;this.questStats.voyages++;this.onChange();return '';
  }
  returnHome(){if(!this.atSea())return;this.voyageUntil=0;this.activeVoyageSupplies={salvage_net:false,current_compass:false};this.onChange();this.onNotice('奶蛙已返航，本次航行不会退还体力');}
  eatError(){if(this.stamina>=this.settings.max_stamina)return '体力已满，无需吃饭';if(this.count('pork_rice')<1)return '背包里没有猪脚饭';return '';}
  eatFood(now=Date.now()){this.syncClock(now);const error=this.eatError();if(error)return error;const gain=Math.min(this.settings.food_stamina_restore,this.settings.max_stamina-this.stamina);this.inventory.pork_rice--;this.stamina+=gain;if(this.stamina===this.settings.max_stamina)this.staminaAt=now;this.onChange();this.onNotice(`奶蛙吃了一份猪脚饭，体力 +${gain}`);return '';}
  salvageError(now=Date.now()){if(!this.atSea())return '先出海再打捞';if(now<this.salvageUntil)return `打捞准备中 · ${Math.ceil((this.salvageUntil-now)/1000)} 秒`;if(this.rawCommittedTotal()>=this.capacity())return '原料仓已满，返航制作或扩建仓库吧';return '';}
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
  salvage(now=Date.now(),rng=Math.random,manualBonus=0){
    const maxBonus=this.settings.minigames?.salvage_hook?.max_bonus||0;if(!nonnegative(manualBonus)||manualBonus>maxBonus)return {error:'手动打捞加成无效'};this.syncClock(now);const error=this.salvageError(now);if(error)return {error};
    const table=this.settings.salvage_loot,total=table.reduce((n,l)=>n+l.weight,0);let pick=rng()*total,loot=table.at(-1);
    for(const row of table){pick-=row.weight;if(pick<0){loot=row;break;}}
    let item=loot.item,quantity=loot.min+Math.floor(rng()*(loot.max-loot.min+1));const route=this.voyageRouteConfig()||{quantity_percent:0,fine_bonus:0,rare_bonus:0},b=this.companion.equipped?this.companionBonuses():{quantity:0,fine:0,rare:0},gear=this.settings.voyage_equipment||{},net=this.activeVoyageSupplies.salvage_net?gear.salvage_net?.quantity_percent||0:0,compass=this.activeVoyageSupplies.current_compass?gear.current_compass||{}:{},expected=quantity*(1+(b.quantity+route.quantity_percent+net)/100),base=Math.floor(expected);quantity=base+(rng()<expected-base?1:0)+manualBonus;const rare=b.rare+route.rare_bonus+(compass.rare_bonus||0),fine=b.fine+route.fine_bonus+(compass.fine_bonus||0),quality=rng()*100;if(quality<rare)item='rare_cargo';else if(quality<rare+fine)item='fine_cargo';
    const amount=this.collect(item,quantity);if(!amount)return {error:'原料仓已满'};
    this.salvageUntil=now+this.settings.salvage_seconds*1000;this.questStats.salvages++;this.gainCompanionXp();this.onChange();return {item,amount,error:''};
  }
  snapshot(){return structuredClone({version:1,arcade:this.arcade,cargoCrateUpgrades:this.cargoCrateUpgrades,voyageSupplies:this.voyageSupplies,activeVoyageSupplies:this.activeVoyageSupplies,developmentClaims:this.developmentClaims,orderStreak:this.orderStreak,bestOrderStreak:this.bestOrderStreak,voyageRoute:this.voyageRoute,warehousePolicies:this.warehousePolicies,deliveryTask:this.deliveryTask,wanderer:this.wanderer,wandererClock:this.wandererClock,employeePaused:this.employeePaused,employeePausedAt:this.employeePausedAt,employeeContracts:this.employeeContracts,landmarks:this.landmarks,questStats:this.questStats,questBoards:this.questBoards,employeeMeals:this.employeeMeals,employeeJobs:this.employeeJobs,employees:this.employees,housing:this.housing,construction:this.construction,companion:this.companion,stamina:this.stamina,staminaAt:this.staminaAt,voyageUntil:this.voyageUntil,salvageUntil:this.salvageUntil,inventory:this.inventory,coins:this.coins,reputation:this.reputation,trades:this.trades,gathered:this.gathered,tiles:[...this.tiles],structures:this.structures,queue:this.queue,visitors:this.visitors,clock:this.clock,nextVisitor:this.nextVisitor,elapsed:this.elapsed});}
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
      const defaultRoute=this.settings.voyage_routes?.[0]?.id||'coast',voyageRoute=data.voyageRoute??defaultRoute;if(!this.voyageRouteConfig(voyageRoute))throw Error();
      const supplyIds=Object.keys(this.settings.voyage_equipment||{}),voyageSupplies=structuredClone(data.voyageSupplies??Object.fromEntries(supplyIds.map(id=>[id,false]))),activeVoyageSupplies=structuredClone(data.activeVoyageSupplies??Object.fromEntries(supplyIds.map(id=>[id,false])));for(const supplies of [voyageSupplies,activeVoyageSupplies])if(!supplies||typeof supplies!=='object'||Array.isArray(supplies)||Object.keys(supplies).some(id=>!supplyIds.includes(id))||supplyIds.some(id=>typeof supplies[id]!=='boolean'))throw Error();if(!voyageUntil&&Object.values(activeVoyageSupplies).some(Boolean))throw Error();
      const cargoCrateUpgrades=data.cargoCrateUpgrades??0;if(!nonnegative(cargoCrateUpgrades)||cargoCrateUpgrades>this.settings.cargo_crate_max)throw Error();
      const milestoneIds=(this.settings.development_milestones||[]).map(row=>row.id),developmentClaims=structuredClone(data.developmentClaims??[]);if(!Array.isArray(developmentClaims)||new Set(developmentClaims).size!==developmentClaims.length||developmentClaims.some(id=>!milestoneIds.includes(id)))throw Error();
      const orderStreak=data.orderStreak??0,bestOrderStreak=data.bestOrderStreak??orderStreak;if(!nonnegative(orderStreak)||!nonnegative(bestOrderStreak)||orderStreak>bestOrderStreak||bestOrderStreak>data.trades)throw Error();
      const arcade=structuredClone(data.arcade??{tide_match:{availableAt:0,plays:0,bestMoves:null,bestSeconds:null}}),tideMatch=arcade?.tide_match;
      if(!arcade||typeof arcade!=='object'||Array.isArray(arcade)||Object.keys(arcade).some(id=>id!=='tide_match')||!tideMatch||typeof tideMatch!=='object'||Array.isArray(tideMatch)||!Number.isFinite(tideMatch.availableAt)||tideMatch.availableAt<0||!nonnegative(tideMatch.plays)||(tideMatch.bestMoves!==null&&(!positive(tideMatch.bestMoves)||tideMatch.bestMoves<this.settings.minigames.tide_match.pairs))||(tideMatch.bestSeconds!==null&&(!Number.isFinite(tideMatch.bestSeconds)||tideMatch.bestSeconds<=0||tideMatch.bestSeconds>3600)))throw Error();
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
      const defaults={food_supplier:'1,-1',renbo:'-2,0',chaorui:'2,0',muscle_frog:'-2,-1',zihao:'2,1',haozi:'1,2',bian:'-1,1',feidudu:'0,-2',flag:'-2,-2'},landmarks=structuredClone(copy.landmarks??defaults);
      if(!landmarks||typeof landmarks!=='object'||Array.isArray(landmarks)||Object.keys(landmarks).some(id=>!Object.hasOwn(defaults,id)))throw Error();
      const occupied=new Set(Object.keys(copy.structures));for(const id of Object.keys(defaults)){let target=landmarks[id]??defaults[id];if(copy.landmarks!==undefined&&(typeof target!=='string'||!tiles.has(target)))throw Error();if(!tiles.has(target)||occupied.has(target))target=[...tiles].find(k=>!occupied.has(k));if(!target)throw Error();landmarks[id]=target;occupied.add(target);}
      const housing=data.housing??{dorm:null,trainedAt:0,progress:0};
      if(!housing||typeof housing!=='object'||Array.isArray(housing)||!Number.isFinite(housing.trainedAt)||housing.trainedAt<0||!Number.isFinite(housing.progress)||housing.progress<0||housing.progress>=this.settings.dormitory_xp_seconds*1000||(housing.dorm!==null&&(typeof housing.dorm!=='string'||copy.structures[housing.dorm]?.id!=='dormitory'||companion.equipped)))throw Error();
      const employees=structuredClone(data.employees??Object.fromEntries(Object.keys(this.settings.employees||{}).map(id=>[id,[]])));
      if(!employees||typeof employees!=='object'||Array.isArray(employees)||Object.keys(employees).some(id=>!this.settings.employees[id]))throw Error();
      const employeeContracts=structuredClone(data.employeeContracts??Object.fromEntries(Object.keys(this.settings.employees||{}).map(id=>[id,0])));if(!employeeContracts||typeof employeeContracts!=='object'||Array.isArray(employeeContracts)||Object.keys(employeeContracts).some(id=>!this.settings.employees[id]))throw Error();
      for(const [id,config]of Object.entries(this.settings.employees||{})){const timers=employees[id]??[],contracts=employeeContracts[id]??0;if(!Array.isArray(timers)||!nonnegative(contracts)||contracts>timers.length||timers.length-contracts>config.max||timers.some(value=>!Number.isFinite(value)||value<0))throw Error();employees[id]=timers;employeeContracts[id]=contracts;}
      const restoreNow=Date.now(),employeeMeals=structuredClone(data.employeeMeals??Object.fromEntries(Object.keys(this.settings.employees).map(id=>[id,employees[id].map(()=>restoreNow+this.settings.employee_meal_seconds*1000)])));
      if(!employeeMeals||typeof employeeMeals!=='object'||Array.isArray(employeeMeals)||Object.keys(employeeMeals).some(id=>!this.settings.employees[id]))throw Error();
      for(const id of Object.keys(this.settings.employees)){const meals=employeeMeals[id]??[];if(!Array.isArray(meals)||meals.length!==employees[id].length||meals.some(value=>!Number.isFinite(value)||value<0))throw Error();employeeMeals[id]=meals;}
      const employeeJobs=structuredClone(data.employeeJobs??{haozi:employees.haozi.map(()=>null)}),jobSlots=new Set();
      if(!employeeJobs||typeof employeeJobs!=='object'||Array.isArray(employeeJobs)||Object.keys(employeeJobs).some(id=>id!=='haozi')||!Array.isArray(employeeJobs.haozi)||employeeJobs.haozi.length!==employees.haozi.length)throw Error();
      if(legacyLayout)employeeJobs.haozi=employeeJobs.haozi.map(job=>{if(!job||job.slot<restoredDockCapacity)return job;const recipe=this.recipes[job.recipe];if(recipe)for(const[id,amount]of Object.entries(recipe.cost))copy.inventory[id]=(copy.inventory[id]||0)+amount;return null;});
      for(const job of employeeJobs.haozi){if(job===null)continue;if(typeof job!=='object'||Array.isArray(job)||!this.recipes[job.recipe]||!nonnegative(job.slot)||job.slot>=restoredDockCapacity||jobSlots.has(job.slot)||!Number.isFinite(job.completeAt)||job.completeAt<0||!Number.isFinite(job.remaining)||job.remaining<0||((job.completeAt>0)===(job.remaining>0)))throw Error();jobSlots.add(job.slot);}
      const employeePaused=structuredClone(data.employeePaused??{zihao:false,haozi:false}),employeePausedAt=structuredClone(data.employeePausedAt??{zihao:0,haozi:0});
      for(const id of Object.keys(this.settings.employees)){if(typeof employeePaused[id]!=='boolean'||!Number.isFinite(employeePausedAt[id])||employeePausedAt[id]<0||(employeePaused[id]&&employeePausedAt[id]===0)||(!employeePaused[id]&&employeePausedAt[id]!==0))throw Error();}
      const questStats=structuredClone(data.questStats??{voyages:0,salvages:0,gathered:0,expanded:0,built:0,crafted:0}),statKeys=['voyages','salvages','gathered','expanded','built','crafted'];
      if(!questStats||typeof questStats!=='object'||Array.isArray(questStats)||Object.keys(questStats).some(id=>!statKeys.includes(id))||statKeys.some(id=>!nonnegative(questStats[id])))throw Error();
      const questBoards=structuredClone(data.questBoards??{renbo:{refreshedAt:0,serial:0,tasks:[]},chaorui:{refreshedAt:0,serial:0,tasks:[]}}),questIds=new Set();
      if(!questBoards||typeof questBoards!=='object'||Array.isArray(questBoards)||Object.keys(questBoards).some(id=>!this.settings.quests.boards[id]))throw Error();
      for(const [id,templates]of Object.entries(this.settings.quests.boards)){const board=questBoards[id]??{refreshedAt:0,serial:0,tasks:[]};if(!board||typeof board!=='object'||Array.isArray(board)||!Number.isFinite(board.refreshedAt)||board.refreshedAt<0||!nonnegative(board.serial)||!Array.isArray(board.tasks)||board.tasks.length>this.settings.quests.max_per_board)throw Error();for(const task of board.tasks){const template=templates.find(row=>row.kind===task.kind&&row.metric===task.metric);if(!template||typeof task.id!=='string'||!task.id.startsWith(`${id}-`)||questIds.has(task.id)||task.name!==template.name||task.unit!==template.unit||!positive(task.goal)||task.goal<template.min||task.goal>template.max||!nonnegative(task.start))throw Error();questIds.add(task.id);}questBoards[id]=board;}
      const restoredQueueLimit=Math.max(this.settings.queue_legacy_limit||0,this.settings.queue_limit+employees.haozi.length);if(!Array.isArray(data.queue)||data.queue.length>restoredQueueLimit)throw Error();for(const t of data.queue)if(!this.recipes[t.recipe]||!Number.isFinite(t.remaining)||t.remaining<=0||t.remaining>this.recipes[t.recipe].seconds)throw Error();
      const wandererClock=data.wandererClock??0,wanderer=structuredClone(data.wanderer??null),wandererItems=new Set();if(!Number.isFinite(wandererClock)||wandererClock<0)throw Error();if(wanderer&&wanderer.remaining>this.settings.wanderer.visit_seconds&&wanderer.remaining<=600)wanderer.remaining=this.settings.wanderer.visit_seconds;
      if(wanderer!==null){if(!wanderer||typeof wanderer!=='object'||Array.isArray(wanderer)||!nonnegative(wanderer.slot)||wanderer.slot>=restoredDockCapacity||!Number.isFinite(wanderer.remaining)||wanderer.remaining<=0||wanderer.remaining>this.settings.wanderer.visit_seconds||!Number.isFinite(wanderer.age)||wanderer.age<0||!Array.isArray(wanderer.offers)||wanderer.offers.length<this.settings.wanderer.stock_min||wanderer.offers.length>this.settings.wanderer.stock_max)throw Error();for(const offer of wanderer.offers){if(offer.item==='slave_contract'&&!offer.employee){offer.employee='zihao';offer.implemented=true;}const entry=this.settings.wanderer.catalog.find(row=>row.item===offer.item&&(row.employee||null)===(offer.employee||null)),offerKey=`${offer.item}:${offer.employee||''}`;if(!entry||wandererItems.has(offerKey)||!nonnegative(offer.quantity)||offer.quantity>entry.quantity_max||!positive(offer.price)||offer.price<entry.price_min||offer.price>entry.price_max||offer.implemented!==(entry.implemented!==false))throw Error();wandererItems.add(offerKey);}}
      const deliveryTask=structuredClone(data.deliveryTask??null),deliveryConfig=this.settings.delivery_trader;
      if(deliveryTask!==null){const allowed=new Set(deliveryConfig.items.map(row=>row.item));deliveryTask.automatic??=false;if(!deliveryTask||typeof deliveryTask!=='object'||Array.isArray(deliveryTask)||typeof deliveryTask.automatic!=='boolean'||!deliveryTask.buy||!deliveryTask.sell||Object.keys(deliveryTask.buy).some(id=>!allowed.has(id))||Object.keys(deliveryTask.sell).some(id=>!allowed.has(id))||Object.values(deliveryTask.buy).some(amount=>!nonnegative(amount))||Object.values(deliveryTask.sell).some(amount=>!nonnegative(amount))||!positive(deliveryTask.duration)||deliveryTask.duration<deliveryConfig.delivery_min_seconds||deliveryTask.duration>deliveryConfig.delivery_max_seconds||!Number.isFinite(deliveryTask.completeAt)||deliveryTask.completeAt<=0)throw Error();const summary=this.deliverySummary(deliveryTask.buy,deliveryTask.sell);for(const field of ['buyCost','sellRevenue','buyTotal','sellTotal','coinCharge','coinPayout'])if(deliveryTask[field]!==summary[field])throw Error();if(!summary.buyTotal&&!summary.sellTotal)throw Error();}
      const warehousePolicies=structuredClone(data.warehousePolicies??Object.fromEntries(deliveryConfig.items.map(row=>[row.item,{min:0,max:null}])));if(this.warehousePolicyError(warehousePolicies))throw Error();
      if(!Array.isArray(copy.visitors))throw Error();const availableSlots=Array.from({length:restoredDockCapacity},(_,slot)=>slot).filter(slot=>slot!==wanderer?.slot);copy.visitors=copy.visitors.slice(0,availableSlots.length).map((visitor,index)=>({...visitor,slot:availableSlots[index]}));const slots=new Set();for(const v of copy.visitors){if(!this.npcs[v.npc]||!this.items[v.item]||!positive(v.quantity)||!positive(v.reward)||!nonnegative(v.slot)||v.slot>=restoredDockCapacity||slots.has(v.slot)||!Number.isFinite(v.remaining)||v.remaining<=0||!Number.isFinite(v.age)||v.age<0)throw Error();slots.add(v.slot);}
      this.companion=structuredClone(companion);
      this.housing=structuredClone(housing);
      this.employees=structuredClone(employees);
      this.employeeContracts=structuredClone(employeeContracts);
      this.employeeMeals=structuredClone(employeeMeals);
      this.employeeJobs=structuredClone(employeeJobs);
      this.employeePaused=structuredClone(employeePaused);
      this.employeePausedAt=structuredClone(employeePausedAt);
      this.wanderer=structuredClone(wanderer);
      this.wandererClock=wandererClock;
      this.deliveryTask=structuredClone(deliveryTask);
      this.warehousePolicies=structuredClone(warehousePolicies);
      this.voyageRoute=voyageRoute;
      this.voyageSupplies=structuredClone(voyageSupplies);
      this.activeVoyageSupplies=structuredClone(activeVoyageSupplies);
      this.cargoCrateUpgrades=cargoCrateUpgrades;
      this.developmentClaims=structuredClone(developmentClaims);
      this.orderStreak=orderStreak;
      this.bestOrderStreak=bestOrderStreak;
      this.arcade=structuredClone(arcade);
      this.questStats=structuredClone(questStats);
      this.questBoards=structuredClone(questBoards);
      this.construction=structuredClone(construction);
      this.landmarks=structuredClone(landmarks);
      for(const p of ['inventory','coins','reputation','trades','gathered','structures','queue','visitors','clock','nextVisitor','elapsed'])this[p]=copy[p];this.tiles=tiles;this.stamina=stamina;this.staminaAt=staminaAt;this.voyageUntil=voyageUntil;this.salvageUntil=salvageUntil;this.syncClock();this.onChange();return '';
    }catch{return '存档无法读取，原文件已保留。可下载备份后开始新局。';}
  }
}
