import { LifecyclePreferencesSchema,LifecyclePreferencesUpdateSchema,StartupUpdateSchema,OnboardingUpdateSchema,type LifecyclePreferences,type StartupStatus } from '@waleed/contracts';
import { HubError } from '../errors.js';
export const defaultLifecyclePreferences:LifecyclePreferences={revision:0,backgroundHealthChecks:false,keepRunningInTray:true,onboardingCompleted:false};
export interface LifecyclePreferencesStore {read():Promise<LifecyclePreferences>;write(expectedRevision:number,next:LifecyclePreferences):Promise<void>}
export interface StartupRegistration {query():Promise<StartupStatus>;set(enabled:boolean,expectedState:'enabled'|'disabled'):Promise<StartupStatus>}
export function memoryLifecyclePreferences():LifecyclePreferencesStore {
  let value=structuredClone(defaultLifecyclePreferences);return {async read(){return structuredClone(value);},async write(expected,next){if(value.revision!==expected)throw new HubError('conflict','Lifecycle settings changed.');value=LifecyclePreferencesSchema.parse(next);}};
}
export function createLifecycleSettings(store:LifecyclePreferencesStore=memoryLifecyclePreferences(),startup?:StartupRegistration,assertWritable:()=>Promise<void>=async()=>{}){
  let busy=false,closed=false;
  const mutate=async<T>(action:()=>Promise<T>)=>{if(closed)throw new HubError('unavailable','Lifecycle settings are closed.');if(busy)throw new HubError('busy','Lifecycle setting is changing.');busy=true;try{await assertWritable();return await action();}finally{busy=false;}};
  return {
    startupAvailable:!!startup,
    preferences:()=>store.read(),
    update:(raw:unknown)=>mutate(async()=>{const input=LifecyclePreferencesUpdateSchema.parse(raw),current=await store.read();if(current.revision!==input.expectedRevision)throw new HubError('conflict','Lifecycle settings changed.');const next=LifecyclePreferencesSchema.parse({...current,revision:current.revision+1,backgroundHealthChecks:input.backgroundHealthChecks,keepRunningInTray:input.keepRunningInTray,...(input.onboardingCompleted===undefined?{}:{onboardingCompleted:input.onboardingCompleted})});await store.write(current.revision,next);return next;}),
    async onboarding(){const {revision,onboardingCompleted}=await store.read();return {revision,onboardingCompleted};},
    setOnboarding:(raw:unknown)=>mutate(async()=>{const input=OnboardingUpdateSchema.parse(raw),current=await store.read();if(current.revision!==input.expectedRevision)throw new HubError('conflict','Lifecycle settings changed.');const next=LifecyclePreferencesSchema.parse({...current,revision:current.revision+1,onboardingCompleted:input.onboardingCompleted});await store.write(current.revision,next);return {revision:next.revision,onboardingCompleted:next.onboardingCompleted};}),
    async startup(){return startup?startup.query():{available:false,state:'unavailable' as const,enabled:false};},
    setStartup:(raw:unknown)=>mutate(async()=>{const input=StartupUpdateSchema.parse(raw);if(!startup)throw new HubError('unavailable','A verified Windows launcher is required.');return startup.set(input.enabled,input.expectedState);}),
    close(){closed=true;},
  };
}
