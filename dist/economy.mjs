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
    this.structures={'0,2':{id:'dock',rotation:0},'1,0':{id:'shop',rotation:0}};
    this.queue=[]; this.visitors=[]; this.clock=0; this.nextVisitor=0; this.elapsed=0;
    this.stamina=this.settings.max_stamina;this.staminaAt=Date.now();this.voyageUntil=0;this.salvageUntil=0;
    this.spawnVisitor();this.spawnVisitor();this.onChange();
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
    this.inventory[id]=this.count(id)+amount;this.gathered+=amount;this.onChange();return amount;
  }
  craftError(id){const r=this.recipes[id];if(!r)return '配方不存在';if(this.atSea())return '返航后安排制作';if(!this.has('workshop'))return '先在浮岛上建造加工台';if(this.reputation<r.reputation)return `声望 ${r.reputation} 解锁`;if(this.queue.length>=this.settings.queue_limit)return '制作队列已满';if(!this.afford(r.cost))return '材料不足，出海打捞，或找供应商买饭吧';return '';}
  craft(id){const error=this.craftError(id);if(error)return error;const r=this.recipes[id];this.spend(r.cost);this.queue.push({recipe:id,remaining:r.seconds});this.onChange();return '';}
  edge(k){const [x,z]=cell(k);return directions.some(([dx,dz])=>!this.tiles.has(key(x+dx,z+dz)));}
  reservedCell(){const preferred=['1,-1','2,-1','-2,-1','-1,1'];return preferred.find(k=>this.tiles.has(k)&&!this.structures[k])||[...this.tiles].find(k=>!this.structures[k])||null;}
  placementError(mode,k){
    if(this.atSea())return '返航后才能建造';
    const [x,z]=cell(k);if(!Number.isInteger(x)||!Number.isInteger(z)||Math.max(Math.abs(x),Math.abs(z))>this.settings.max_grid_radius)return '超出可扩建范围';
    if(mode==='expand'){
      if(this.tiles.has(k))return '这里已有平台';
      if(!directions.some(([dx,dz])=>this.tiles.has(key(x+dx,z+dz))))return '平台必须连接现有浮岛';
      for(const [pos,b]of Object.entries(this.structures)){if(b.id!=='dock')continue;const[a,c]=cell(pos);if(!directions.some(([dx,dz])=>!this.tiles.has(key(a+dx,c+dz))&&key(a+dx,c+dz)!==k))return '码头旁需要保留水面';}
      return this.afford(this.settings.expansion_cost)?'':'浮木不足';
    }
    const b=this.buildings[mode];if(!b)return '请选择建筑';
    if(['shop','workshop','dock'].includes(mode)&&this.has(mode))return `${b.name}已有一座`;
    if(!this.tiles.has(k))return '先在这里扩建平台';if(this.structures[k])return '这里已有建筑';if(k===this.reservedCell())return '这里是食物供应商的摊位';
    if(mode==='dock'&&!this.edge(k))return '码头需要建在边缘';return this.afford(b.cost,b.coins)?'':'材料或金币不足';
  }
  build(mode,k,rotation=0){const error=this.placementError(mode,k);if(error)return error;if(mode==='expand'){this.spend(this.settings.expansion_cost);this.tiles.add(k);}else{const b=this.buildings[mode];this.spend(b.cost,b.coins);this.structures[k]={id:mode,rotation:((rotation%4)+4)%4};}this.onChange();return '';}
  purchaseError(vendorId,index=0){const offer=this.vendors[vendorId]?.offers[index];if(!offer)return '商品不存在';if(this.atSea())return '返航后购买';if(this.coins<offer.price)return '金币不足，先完成一些订单吧';if(!this.has('workshop')&&this.coins-offer.price<this.buildings.workshop.coins)return '先留够建造加工台的金币，再来买饭吧';if(this.items[offer.item].kind==='resource'&&this.rawTotal()+offer.quantity>this.capacity())return '原料仓容量不足';return '';}
  buy(vendorId,index=0){const error=this.purchaseError(vendorId,index);if(error)return error;const offer=this.vendors[vendorId].offers[index];this.coins-=offer.price;this.inventory[offer.item]=this.count(offer.item)+offer.quantity;this.onChange();this.onNotice(`购买成功：${this.items[offer.item].name} +${offer.quantity}`);return '';}
  spawnVisitor(){
    if(this.visitors.length>=3||!this.has('dock')||!this.has('shop'))return;
    const ids=Object.keys(this.npcs),id=ids[this.nextVisitor++%ids.length];
    const prefs=this.npcs[id].preferences.filter(p=>!Object.values(this.recipes).some(r=>r.output===p.item&&r.reputation>this.reputation));
    if(!prefs.length)return;const p=prefs[Math.floor(Math.random()*prefs.length)];let slot=0;while(this.visitors.some(v=>v.slot===slot))slot++;
    this.visitors.push({npc:id,...p,slot,remaining:this.settings.visitor_seconds,age:0});this.onChange();
  }
  tradeError(slot){if(this.atSea())return '返航后交付订单';const v=this.visitors.find(v=>v.slot===slot);if(!v)return '顾客已离港';if(v.age<2)return '顾客正在靠岸';if(this.count(v.item)<v.quantity)return '商品不足，先制作一些吧';return '';}
  trade(slot){const error=this.tradeError(slot);if(error)return error;const index=this.visitors.findIndex(v=>v.slot===slot),v=this.visitors[index];this.inventory[v.item]-=v.quantity;this.coins+=v.reward;this.reputation++;this.trades++;this.visitors.splice(index,1);this.onChange();this.onNotice(`交易成功！金币 +${v.reward} · 声望 +1`);return '';}
  tick(dt){
    this.syncClock();
    if(!Number.isFinite(dt)||dt<=0)return;this.elapsed+=dt;let budget=dt,dirty=false;
    while(this.queue.length&&budget>0){const task=this.queue[0],spent=Math.min(budget,task.remaining);task.remaining-=spent;budget-=spent;if(task.remaining<=1e-7){const r=this.recipes[task.recipe];this.inventory[r.output]=this.count(r.output)+r.amount;this.queue.shift();dirty=true;this.onNotice(`${this.items[r.output].name} 制作完成`);}}
    for(const v of this.visitors){v.remaining-=dt;v.age+=dt;}const n=this.visitors.length;this.visitors=this.visitors.filter(v=>v.remaining>0);dirty ||= n!==this.visitors.length;
    this.clock+=dt;if(this.clock>=this.settings.arrival_seconds){this.clock%=this.settings.arrival_seconds;this.spawnVisitor();}
    if(dirty)this.onChange();
  }
  atSea(){return this.voyageUntil>0;}
  syncClock(now=Date.now()){
    let dirty=false;
    if(now<this.staminaAt)this.staminaAt=now;
    if(this.stamina<this.settings.max_stamina){const step=this.settings.stamina_regen_seconds*1000,n=Math.floor((now-this.staminaAt)/step);if(n>0){this.stamina=Math.min(this.settings.max_stamina,this.stamina+n);this.staminaAt=this.stamina===this.settings.max_stamina?now:this.staminaAt+n*step;dirty=true;}}
    if(this.voyageUntil&&now>=this.voyageUntil){this.voyageUntil=0;dirty=true;this.onNotice('本次航行结束，奶娃已安全返航');}
    if(dirty)this.onChange();
  }
  beginVoyage(now=Date.now()){
    this.syncClock(now);if(this.atSea())return '已经在海上';if(this.stamina<this.settings.voyage_stamina_cost)return '体力不足：每小时恢复 1 点，或吃一份猪脚饭恢复 2 点';
    if(this.stamina===this.settings.max_stamina)this.staminaAt=now;
    this.stamina-=this.settings.voyage_stamina_cost;this.voyageUntil=now+this.settings.voyage_seconds*1000;this.salvageUntil=0;this.onChange();return '';
  }
  returnHome(){if(!this.atSea())return;this.voyageUntil=0;this.onChange();this.onNotice('奶娃已返航，本次航行不会退还体力');}
  eatError(){if(this.stamina>=this.settings.max_stamina)return '体力已满，无需吃饭';if(this.count('pork_rice')<1)return '背包里没有猪脚饭';return '';}
  eatFood(now=Date.now()){this.syncClock(now);const error=this.eatError();if(error)return error;const gain=Math.min(this.settings.food_stamina_restore,this.settings.max_stamina-this.stamina);this.inventory.pork_rice--;this.stamina+=gain;if(this.stamina===this.settings.max_stamina)this.staminaAt=now;this.onChange();this.onNotice(`奶娃吃了一份猪脚饭，体力 +${gain}`);return '';}
  salvageError(now=Date.now()){if(!this.atSea())return '先出海再打捞';if(now<this.salvageUntil)return `打捞准备中 · ${Math.ceil((this.salvageUntil-now)/1000)} 秒`;if(this.rawTotal()>=this.capacity())return '原料仓已满，返航制作或扩建仓库吧';return '';}
  salvage(now=Date.now(),rng=Math.random){this.syncClock(now);const error=this.salvageError(now);if(error)return {error};const table=this.settings.salvage_loot,total=table.reduce((n,l)=>n+l.weight,0);let pick=rng()*total,loot=table.at(-1);for(const row of table){pick-=row.weight;if(pick<0){loot=row;break;}}const quantity=loot.min+Math.floor(rng()*(loot.max-loot.min+1)),amount=this.collect(loot.item,quantity);if(!amount)return {error:'原料仓已满'};this.salvageUntil=now+this.settings.salvage_seconds*1000;this.onChange();return {item:loot.item,amount,error:''};}
  snapshot(){return structuredClone({version:1,stamina:this.stamina,staminaAt:this.staminaAt,voyageUntil:this.voyageUntil,salvageUntil:this.salvageUntil,inventory:this.inventory,coins:this.coins,reputation:this.reputation,trades:this.trades,gathered:this.gathered,tiles:[...this.tiles],structures:this.structures,queue:this.queue,visitors:this.visitors,clock:this.clock,nextVisitor:this.nextVisitor,elapsed:this.elapsed});}
  restore(data){
    try{
      if(!data||data.version!==1||!data.inventory||typeof data.inventory!=='object')throw Error();
      const stamina=data.stamina??this.settings.max_stamina,staminaAt=data.staminaAt??Date.now(),voyageUntil=data.voyageUntil??0,salvageUntil=data.salvageUntil??0;
      if(!nonnegative(stamina)||stamina>this.settings.max_stamina||!Number.isFinite(staminaAt)||staminaAt<0||!Number.isFinite(voyageUntil)||voyageUntil<0||!Number.isFinite(salvageUntil)||salvageUntil<0)throw Error();
      for(const [id,n]of Object.entries(data.inventory))if(!this.items[id]||!nonnegative(n))throw Error();
      for(const p of ['coins','reputation','trades','gathered','nextVisitor'])if(!nonnegative(data[p]))throw Error();
      for(const p of ['clock','elapsed'])if(!Number.isFinite(data[p])||data[p]<0)throw Error();
      if(!Array.isArray(data.tiles)||!data.tiles.length||data.tiles.length>289||new Set(data.tiles).size!==data.tiles.length)throw Error();
      for(const k of data.tiles){if(typeof k!=='string'||!/^(-?\d+),(-?\d+)$/.test(k)||cell(k).some(n=>Math.abs(n)>this.settings.max_grid_radius))throw Error();}
      const tiles=new Set(data.tiles),seen=new Set([data.tiles[0]]),front=[data.tiles[0]];for(let i=0;i<front.length;i++){const[x,z]=cell(front[i]);for(const[dx,dz]of directions){const k=key(x+dx,z+dz);if(tiles.has(k)&&!seen.has(k)){seen.add(k);front.push(k);}}}if(seen.size!==tiles.size)throw Error();
      if(!data.structures||typeof data.structures!=='object'||Array.isArray(data.structures))throw Error();
      for(const [k,b]of Object.entries(data.structures)){if(!tiles.has(k)||!this.buildings[b.id]||!nonnegative(b.rotation)||b.rotation>3)throw Error();if(b.id==='dock'){const[x,z]=cell(k);if(!directions.some(([dx,dz])=>!tiles.has(key(x+dx,z+dz))))throw Error();}}
      if(!Array.isArray(data.queue)||data.queue.length>this.settings.queue_limit)throw Error();for(const t of data.queue)if(!this.recipes[t.recipe]||!Number.isFinite(t.remaining)||t.remaining<=0||t.remaining>this.recipes[t.recipe].seconds)throw Error();
      if(!Array.isArray(data.visitors)||data.visitors.length>3)throw Error();const slots=new Set();for(const v of data.visitors){if(!this.npcs[v.npc]||!this.items[v.item]||!positive(v.quantity)||!positive(v.reward)||!nonnegative(v.slot)||v.slot>2||slots.has(v.slot)||!Number.isFinite(v.remaining)||v.remaining<=0||!Number.isFinite(v.age)||v.age<0)throw Error();slots.add(v.slot);}
      const copy=structuredClone(data);for(const id of Object.keys(this.items))copy.inventory[id]??=0;
      for(const p of ['inventory','coins','reputation','trades','gathered','structures','queue','visitors','clock','nextVisitor','elapsed'])this[p]=copy[p];this.tiles=tiles;this.stamina=stamina;this.staminaAt=staminaAt;this.voyageUntil=voyageUntil;this.salvageUntil=salvageUntil;this.syncClock();this.onChange();return '';
    }catch{return '存档无法读取，原文件已保留。可下载备份后开始新局。';}
  }
}
