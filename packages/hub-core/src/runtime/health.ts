import type { Connector,ConnectorHealth,HubState } from '@waleed/contracts';
import type { StateStore } from '../state.js';
import type { SafetyLedger } from '../safety.js';
import type { SecretBackends } from '../auth/secrets.js';
import type { createRuntimeChecks } from './checks.js';
import type { createLifecycleSettings } from './lifecycle-settings.js';
import { approved,definitionHash,hashData } from './registry.js';
import { HealthRetestRequestSchema } from '@waleed/contracts';
import { HubError } from '../errors.js';

type OAuthHealth={expiresAt:number|null;invalid:boolean;unavailable:boolean};
export function inspectOAuthHealth(raw:unknown):OAuthHealth {
  if(!raw||typeof raw!=='object')return {expiresAt:null,invalid:true,unavailable:false};
  const token=raw as Record<string,unknown>;
  const valid=typeof token.accessToken==='string'&&token.accessToken.length>0&&(token.expiresAt===null||(Number.isSafeInteger(token.expiresAt)&&Number(token.expiresAt)>=0))&&(token.refreshToken===null||typeof token.refreshToken==='string');
  return {expiresAt:valid?token.expiresAt as number|null:null,invalid:!valid,unavailable:false};
}
export function createConnectorHealth(store:StateStore,safety:SafetyLedger,checks:ReturnType<typeof createRuntimeChecks>,backends:SecretBackends,settings:ReturnType<typeof createLifecycleSettings>,refreshFailed:(id:string,revision:number)=>boolean=()=>false,now=Date.now,intervalMs=300_000){
  const metadata=new Map<string,{key:string;time:number;value:OAuthHealth}>(),queue=new Set<string>(),owned=new Set<string>();
  let closed=false,pumping=false,ticking=false,metadataOffset=0,pending:Promise<void>=Promise.resolve(),snapshotTask:Promise<{connectors:ConnectorHealth[];running:boolean}>|undefined;
  const controller=new AbortController();
  const inspect=async(connector:Connector,state:HubState,force=false,budget?:AbortSignal):Promise<OAuthHealth|undefined>=>{
    if(!connector.enabled||!approved(connector))return;
    const ref=state.secretReferences.find(ref=>ref.id===connector.headerBindings.Authorization&&ref.kind==='oauth');if(!ref)return;
    const key=hashData([connector.revision,definitionHash(connector),ref]),cached=metadata.get(connector.id);if(!force&&cached?.key===key&&cached.time>now()-30_000)return cached.value;
    if(budget?.aborted)return {invalid:false,unavailable:true,expiresAt:null};
    let value:OAuthHealth;
    if(!ref.present||!ref.ownerIds.includes(connector.id))value={invalid:true,unavailable:false,expiresAt:null};
    else if(ref.adapter!=='windows'||!backends.windows?.read)value={invalid:false,unavailable:true,expiresAt:null};
    else {let bytes:Buffer|undefined;try{bytes=await backends.windows.read(ref.id,AbortSignal.any([controller.signal,AbortSignal.timeout(5000),...(budget?[budget]:[])]));try{if(bytes.length>64*1024)throw new Error();value=inspectOAuthHealth(JSON.parse(bytes.toString('utf8')));}catch{value={invalid:true,unavailable:false,expiresAt:null};}}catch{value={invalid:false,unavailable:true,expiresAt:null};}finally{bytes?.fill(0);}}
    if(!closed&&!budget?.aborted)metadata.set(connector.id,{key,time:now(),value});return value;
  };
  const snapshot=async()=>{
    const state=await store.read(),observations=await checks.observations();
    for(const id of metadata.keys())if(!state.connectors.some(connector=>connector.id===id))metadata.delete(id);
    const inspected=new Map<string,OAuthHealth|undefined>(),budget=AbortSignal.timeout(10000),offset=metadataOffset;let next=0;
    await Promise.all([0,1].map(async()=>{while(next<state.connectors.length){const index=(offset+next++)%state.connectors.length,connector=state.connectors[index]!;inspected.set(connector.id,await inspect(connector,state,false,budget));if(!budget.aborted)metadataOffset=(index+1)%state.connectors.length;}}));
    const connectors:ConnectorHealth[]=[];
    for(const connector of state.connectors){
      const observation=observations.find(item=>item.connectorId===connector.id),oauth=inspected.get(connector.id);
      let status:ConnectorHealth['status']='untested',reason:ConnectorHealth['reason']='not_checked';
      if(!connector.enabled)reason='disabled';else if(!approved(connector))reason='approval_required';
      else if(oauth?.invalid){status='needs_reauth';reason='invalid_oauth';}
      else if(oauth?.expiresAt!==undefined&&oauth.expiresAt!==null&&oauth.expiresAt<=now()+30_000){status='needs_reauth';reason='oauth_expired';}
      else if(refreshFailed(connector.id,connector.revision)){status='needs_reauth';reason='refresh_failed';}
      else if(observation?.reason==='auth_required'||observation?.reason==='auth_expired'){status='needs_reauth';reason='auth_required';}
      else if([...Object.values(connector.secretBindings),...Object.values(connector.headerBindings)].some(id=>!state.secretReferences.some(ref=>ref.id===id&&ref.present&&ref.ownerIds.includes(connector.id)))){status='needs_reauth';reason='credentials_missing';}
      else if(oauth?.unavailable){status='degraded';reason='dependency_unavailable';}
      else if(observation?.state==='connected'){status='healthy';reason='none';}
      else if(observation?.state==='checking')reason='checking';
      else if(observation?.checkedAt){status='degraded';reason='unreachable';}
      connectors.push({connectorId:connector.id,revision:connector.revision,status,reason,checkedAt:observation?.checkedAt??null,expiresAt:oauth?.expiresAt??null});
    }
    const latest=await store.read();if(closed||latest.revision!==state.revision)return {connectors:[],running:pumping};
    return {connectors,running:pumping};
  };
  const pump=async()=>{if(pumping||closed)return;pumping=true;try{while(queue.size&&!closed){const id=queue.values().next().value!;queue.delete(id);try{await safety.assertWritable();const state=await store.read(),connector=state.connectors.find(item=>item.id===id);if(!connector?.enabled||!approved(connector))continue;const oauth=await inspect(connector,state,true);if(oauth?.invalid||oauth?.unavailable||(oauth?.expiresAt!==undefined&&oauth.expiresAt!==null&&oauth.expiresAt<=now()+30_000))continue;
      const job=await checks.start(id,'hub_health',true);owned.add(job.id);try{if(closed)checks.cancel(job.id,'hub_health');await checks.wait(job.id,'hub_health');}finally{owned.delete(job.id);}
    }catch{/* Static health state is derived from observations; never store exceptions. */}}}finally{pumping=false;}};
  const retest=async(raw:unknown={})=>{const input=HealthRetestRequestSchema.parse(raw);if(closed)throw new HubError('unavailable','Health service is closed.');await safety.assertWritable();const state=await store.read();if(input.connectorId&&!state.connectors.some(item=>item.id===input.connectorId))throw new HubError('not_found','Connector is missing.');for(const connector of state.connectors)if(connector.enabled&&approved(connector)&&(!input.connectorId||input.connectorId===connector.id))queue.add(connector.id);if(!pumping)pending=pump();return {accepted:true as const};};
  const tick=async()=>{if(closed||ticking)return;ticking=true;try{if((await settings.preferences()).backgroundHealthChecks)await retest();}catch{/* Corrupt/unavailable preferences never enable background execution. */}finally{ticking=false;}};
  const timer=setInterval(()=>void tick(),intervalMs);timer.unref();
  return {snapshot(){if(closed)throw new HubError('unavailable','Health service is closed.');return snapshotTask??=(snapshot().finally(()=>{snapshotTask=undefined;}));},retest,tick,async drain(){await pending;},async close(){closed=true;controller.abort();clearInterval(timer);queue.clear();for(const id of owned)checks.cancel(id,'hub_health');await pending;await snapshotTask?.catch(()=>undefined);metadata.clear();}};
}
