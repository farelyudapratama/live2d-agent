/**
 * agent/brain.ts — The agent "brain". Parity with agent.js (841 LOC).
 * Manages history, capability profile, two-pass animation director, moods.
 */
import { parseSegments, stripDirectives, hasDirectives, guessEmotion, segmentTextFallback } from "./directive-parser";
import type { ChatMessage, ParsedSegment, CapabilityProfile } from "../../shared/types";

const HISTORY_LIMIT = 12;
const API = (typeof location !== "undefined" && /^https?:$/.test(location.protocol)) ? location.origin : "http://127.0.0.1:8310";

const EVENT_PROMPTS: Record<string,string> = {
  idle: "User diam tidak mengatakan apa-apa padahal dia ada di depanmu. Mulai ngobrol sendiri secara santai, seperti karakter yang menunggu dan mencoba meramaikan suasana. Boleh cerita ringan atau tanya hal kecil.",
  user_left: "User tiba-tiba pergi / menghilang dari depan layar. Tunjukkan kalau kamu perhatian dan sedikit sedih atau nunggu dia balik. Bilang sesuatu yang manis sebelum dia pergi.",
  user_returned: "User baru saja balik setelah tadi pergi. Sambut dia dengan senang, seperti menyambut teman yang kembali.",
  "mood:marah": "User terlihat MARAH/kesal dari ekspresi wajahnya. Tunjukkan empati, tanyakan kenapa, jangan bikin dia makin kesal. Tenang dan pengertian.",
  "mood:sedih": "User terlihat SEDIH dari ekspresi wajahnya. Hibur dia dengan lembut: \"jangan sedih ya\", \"kalau kamu sedih aku juga sedih nih\", tawarkan dengar ceritanya.",
  "mood:senang": "User terlihat SENANG/bahagia. Ikut senang dan rayakan mood-nya, tunjukkan antusias.",
  "mood:kaget": "User terlihat KAGET. Tanyakan ada apa, tunjukkan kepedulian.",
};

const EMOTION_GESTURE_FALLBACK: Record<string,string> = { senang:"lean_excited", sedih:"look_away_shy", malu:"look_away_shy", kaget:"recoil_surprised", normal:"nod" };
const EVENT_EMOTION_PREFS: Record<string,string[]> = {
  user_left: ["sedih","malu","bingung"], user_returned: ["senang","tersenyum","kaget"],
  "mood:sedih": ["sedih","bingung"], "mood:marah": ["bingung","kaget","sedih"],
  "mood:senang": ["senang","tersenyum"], "mood:kaget": ["kaget","bingung"],
};

export class AgentBrain {
  private history: ChatMessage[] = [];
  private busy=false;
  private capProfile: CapabilityProfile | null = null;
  private userMood="normal";
  private moodSource: string|null=null;
  private presenceState: boolean|null=null;
  private agentStart=Date.now();
  private quietMs=1_800_000;
  private onSegments?: (s:ParsedSegment[])=>void;
  private onThinking?: (on:boolean)=>void;
  private onMoodChange?: (m:string)=>void;

  constructor(cbs:{onSegments?:(s:ParsedSegment[])=>void; onThinking?:(on:boolean)=>void; onMoodChange?:(m:string)=>void}){
    this.onSegments=cbs.onSegments; this.onThinking=cbs.onThinking; this.onMoodChange=cbs.onMoodChange;
  }

  private motionCatalogBlock(profile: CapabilityProfile|null): string {
    const cat=(profile && Array.isArray((profile as any).motionCatalog))? (profile as any).motionCatalog: [];
    if(!cat.length) return "";
    let s="\n=== GERAKAN BUATAN USER (Motion Studio) ===\nFormat: [MOTION:id] — PAKAI PERSIS id di bawah, jangan mengarang.\n";
    for(const m of cat.slice(0,24)) s+=`- ${m.id}: ${(m.description||m.id)}${m.tags?.length? ` [tag: ${m.tags.join(", ")}]`:""}${(m as any).compatibleEmotions?.length? ` (cocok saat: ${(m as any).compatibleEmotions.join(", ")})`:""}\n`;
    s+="Gerakan ini dirancang user sendiri, jadi UTAMAKAN dipakai kalau maknanya pas.\nJangan pakai kalau bertabrakan dengan emosi segmen itu. Boleh tambah [INTENSITY:0.3-1.0].\n";
    return s;
  }

  private buildSystemPrompt(basePrompt=""): string {
    let sys=basePrompt||""; if(!this.capProfile) return sys;
    const sheet=(this.capProfile as any).sheet;
    let paramRef="";
    if(sheet?.params?.length){
      const byGroup:Record<string,any[]>={}; for(const p of sheet.params){ (byGroup[p.group]=byGroup[p.group]||[]).push(p); }
      paramRef="\nDAFTAR PARAMETER LENGKAP (min..max, default):\n";
      if(sheet.rangesEstimated) paramRef+="⚠️ range estimasi dari nama, pakai nilai konservatif.\n";
      for(const g in byGroup){ paramRef+=g+":\n"; for(const p of byGroup[g]){ paramRef+=`  ${p.id} (${p.label}): ${p.min}..${p.max}, default=${p.def}${p.estimated?" [estimasi]":""}\n`; const pn=(p.userNote||"").trim(); if(pn) paramRef+=`    📝 penjelasan user: ${pn.slice(0,300)}\n`; } }
    }
    const note=typeof (this.capProfile as any).userNote==="string"? (this.capProfile as any).userNote.trim():"";
    const noteBlock=note?`\n\n=== CATATAN KARAKTER (ditulis oleh user) ===\n--- awal catatan ---\n${note}\n--- akhir catatan ---\n`:"";
    const cap=this.capProfile as any;
    const capBlock=`\n\n=== KARAKTER LIVE2D — KENDALI PENUH ===\nKamu memainkan karakter anime LIVE2D. KAMU bisa menggerakkan karakter ini secara real-time!\n${noteBlock}\n=== DAFTAR EMOSI ===\n${cap.emotions?.join(", ")||"tidak ada preset emosi"}\nFormat: [EMOTION:nama]\n\n=== DAFTAR EXPRESSION / PROPERTI BAWAAN ===\n${cap.nativeExpressions?.join(", ")||"tidak ada"}\nFormat: [EXPR:nama] atau [PROP:nama]\n${cap.properties?.length? `Properti: ${cap.properties.join(", ")}\nGunakan [PROP:nama].`:""}\n\n=== DAFTAR AKSESORIS ===\n${cap.accessories?.join(", ")||"tidak ada"}\nFormat: [ACC:ParamXX:1] nyalakan, [ACC:ParamXX:0] matikan\n\n=== DAFTAR PARAMETER (dengan range aktual dari model) ===\n${paramRef||"Tidak ada data parameter."}\n\n=== DAFTAR GESTURE (gerakan siap-pakai, PALING DIUTAMAKAN untuk gerak) ===\n${cap.gestures?.join(", ")||"nod, shake, tilt_curious, lean_excited, recoil_surprised, look_away_shy, laugh_bounce, think, wave_hi"}\nFormat: [GESTURE:nama]\nUTAMAKAN pilih dari daftar ini setiap ada momen ekspresif.\n${this.motionCatalogBlock(this.capProfile)}\n\n=== FORMAT DIRECTIVE ===\n1. EMOSI: [EMOTION:senang] [EMOTION:sedih] [EMOTION:malu] [EMOTION:kaget] [EMOTION:normal]\n2. GESTURE: [GESTURE:nama]\n3. KEPALA: [HEAD:x,y]\n4. MATA: [EYES:x,y]\n5. MULUT: [MOUTH:form,open]\n6. BADAN: [BODY:x,y,z]\n7. AKSESORIS: [ACC:ParamXX:1] atau [ACC:ParamXX:0]\n8. EXPRESSION: [EXPR:nama] atau [PROP:nama]\n\n=== MULTI-SEGMENT (WAJIB) ===\nPecah di titik koma/jeda alami kalau ada perubahan nada, biar karakter berubah SEIRAMA omongannya.\nContoh: [EMOTION:senang][GESTURE:wave_hi] Halo! [EMOTION:senang][GESTURE:lean_excited] Senang banget ketemu kamu~\n\n=== ATURAN ===\n1. SELALU sertakan [EMOTION:...] di setiap segment; TAMBAHKAN [GESTURE:...] di momen ekspresif\n2. UTAMAKAN [GESTURE] daripada [HEAD]/[BODY] manual\n3. GUNAKAN range benar dari daftar di atas\n4. Jangan pakai directive tidak ada di daftar\n5. Balasan natural — directive tersembunyi\n6. Boleh 3-6 kalimat, sesuaikan emosi & gesture per kalimat/klausa\n7. Emosi & gesture HARUS cocok isi kalimat\n---`;
    return sys + capBlock;
  }

  private async animateTextViaDirector(text:string, profile:CapabilityProfile|null): Promise<ParsedSegment[]>{
    try{
      const res=await fetch(API+"/api/animate-text",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text, capabilities:{emotions: profile?.emotions||["senang","tersenyum","sedih","malu","kaget","kesal","bingung","normal"], gestures: profile?.gestures||Object.keys(EMOTION_GESTURE_FALLBACK), motions: (profile as any)?.motionCatalog||[]}})});
      if(!res.ok) throw new Error("Director HTTP "+res.status);
      const data=await res.json(); const raw=data.segments||[];
      if(Array.isArray(raw)&&raw.length) return raw.map((s:any)=>({text:s.text||"", actions:{emotion:s.emotion||"normal", gesture:s.gesture||null, motion:s.motion||null, intensity: typeof s.intensity==="number"?s.intensity:0.8}})).filter((s:ParsedSegment)=>s.text.trim().length>0);
    }catch(e:any){ console.warn("[agent] Director fallback",e.message); }
    return segmentTextFallback(text);
  }

  async think(userText:string): Promise<void>{
    if(this.busy) return; if(!(window as any).__live2dAgent?.isReady?.()) { console.warn("[agent] model not ready"); return; }
    if(!this.capProfile) try{ await this.loadProfile(); }catch(e){ console.warn("[agent] profile unavailable",e); }
    this.busy=true; this.history.push({role:"user",content:userText}); if(this.history.length>HISTORY_LIMIT*2) this.history.splice(0,this.history.length-HISTORY_LIMIT*2);
    this.onThinking?.(true);
    try{
      const resp=await fetch(API+"/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:this.history, system: this.buildSystemPrompt("")+this.moodSuffix()})});
      if(!resp.ok){ const e=await resp.json().catch(()=>({})); throw new Error(e.error||("HTTP "+resp.status)); }
      const data=await resp.json(); const reply=(data.reply||"").trim();
      if(reply){
        const clean=stripDirectives(reply); let segments=parseSegments(reply);
        if(!hasDirectives(reply) || segments.length<=1) segments=await this.animateTextViaDirector(clean, this.capProfile);
        this.onSegments?.(segments);
      } else (window as any).__live2dAgent?.speak?.("Hmm, aku bingung jawabnya...");
    }catch(err:any){ console.error("[agent]",err); (window as any).__live2dAgent?.speak?.("Maaf, aku lagi gak bisa mikir sekarang. Cek koneksi atau api key ya."); }
    finally{ this.onThinking?.(false); this.busy=false; }
  }

  async reactEvent(type:string): Promise<void>{
    if(this.busy) return; if(type==="idle" && !this.getEvents().idleSpeak) return; if(this.inQuietPeriod()){ console.log("[agent] masa tenang, skip",type); return; }
    if(!(window as any).__live2dAgent?.isReady?.()) return;
    if(!this.capProfile) try{ await this.loadProfile(); }catch{}
    this.busy=true; this.onThinking?.(true);
    try{
      const system=this.buildSystemPrompt("")+`\n\n[EVENT: ${type}] ${EVENT_PROMPTS[type]||""}${this.moodSuffix()}\nBalas SINGKAT dan natural (1-3 kalimat), seperti karakter merespons kejadian, BUKAN menjawab pertanyaan. Jangan pakai bahasa bahwa kamu adalah AI.`;
      const synthetic=`(${type})`; const messages=this.history.slice(-6).concat([{role:"user",content:synthetic}]);
      const resp=await fetch(API+"/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages, system})});
      if(!resp.ok) throw new Error("HTTP "+resp.status);
      const data=await resp.json(); const reply=(data.reply||"").trim();
      if(reply){
        const clean=stripDirectives(reply); let segments=parseSegments(reply);
        if(!hasDirectives(reply) || segments.length<=1) segments=await this.animateTextViaDirector(clean, this.capProfile);
        this.onSegments?.(segments);
      }
    }catch(err){ console.error("[agent] reactEvent",type,err); }
    finally{ this.onThinking?.(false); this.busy=false; }
  }

  setPresence(p:boolean|null):void{
    const was=this.presenceState; this.presenceState=p;
    if(typeof (window as any).__l2dPresenceChanged==="function") (window as any).__l2dPresenceChanged(p);
    if(p===null || this.inQuietPeriod()) return;
    const ev=this.getEvents();
    if(p===false && was!==false){ if(!ev.awaySpeak) return; this.expressEventEmotion("user_left"); this.reactEvent("user_left"); }
    else if(p===true && was===false){ if(!ev.returnSpeak) return; this.expressEventEmotion("user_returned"); this.reactEvent("user_returned"); }
  }

  private pickSupportedEmotion(prefs:string[]): string|null{
    const l2d=(window as any).__live2dAgent; if(!l2d||!prefs?.length) return null;
    let vocab:Record<string,any>={}; try{ vocab=(l2d.getExpressibleEmotions&&l2d.getExpressibleEmotions())||{}; }catch{ vocab={}; }
    const names=Object.keys(vocab); if(!names.length) return null;
    for(const p of prefs) if(names.indexOf(p)!==-1) return p; return null;
  }
  private expressEventEmotion(type:string){
    const l2d=(window as any).__live2dAgent; if(!l2d) return null;
    const name=this.pickSupportedEmotion(EVENT_EMOTION_PREFS[type]||[]); if(!name) return null;
    try{ const via=l2d.expressEmotion? l2d.expressEmotion(name):(l2d.setExpression(name),"legacy"); console.log("[agent] reaksi",type,"->",name,via); return via; }catch(e:any){ console.warn("[agent] expressEmotion gagal",e.message); return null; }
  }

  setMood(m:string, source?:string):void{
    const next=m||"normal"; if(next==="normal"){ this.userMood="normal"; this.moodSource=null; console.log("[agent] mood -> normal"); return; }
    if(source==="text" && this.moodSource==="camera"){ console.log(`[agent] mood teks (${next}) diabaikan, kamera pegang:`,this.userMood); return; }
    this.userMood=next; this.moodSource=source||this.moodSource||"text"; console.log("[agent] mood ->",this.userMood,`(${this.moodSource})`); this.onMoodChange?.(this.userMood);
    this.expressEventEmotion("mood:"+m); this.reactEvent("mood:"+m);
  }
  setCameraMood(m:string){ if(!m||m==="normal") this.setMood("normal","camera"); else this.setMood(m,"camera"); }

  getMood():string{ return this.userMood; } getPresence():boolean|null{ return this.presenceState; } isBusy():boolean{ return this.busy; }
  invalidateProfile():void{ if(this.capProfile) console.log("[agent] profile invalidated"); this.capProfile=null; }
  async loadProfile():Promise<void>{
    const l2d=(window as any).__live2dAgent;
    if(l2d?.getCapabilityProfile){ this.capProfile=await l2d.getCapabilityProfile(); console.log("[agent] capability profile loaded",this.capProfile); return; }
    try{
      const resp=await fetch(API+"/api/config"); if(resp.ok){
        this.capProfile={ emotions:["senang","tersenyum","sedih","malu","kaget","kesal","bingung","normal"], nativeExpressions:[], accessories:[], properties:[], gestures:["nod","shake","tilt_curious","lean_excited","recoil_surprised","look_away_shy","laugh_bounce","think","wave_hi"], motionCatalog:[], sheet:null, userNote:"", roleIds:{}, paramRange:{} } as any;
      }
    }catch(e){ console.warn("[agent] profile load failed",e); }
  }

  private moodSuffix():string{ return this.userMood&&this.userMood!=="normal"? `\nUser saat ini terlihat ${this.userMood}. Tunjukkan empati yang wajar dan konsisten.`:""; }
  private inQuietPeriod():boolean{ return Date.now() < this.agentStart + this.quietMs; }
  private getEvents(){ return (window as any).__appEvents ?? { idleSpeak:true, awaySpeak:true, returnSpeak:true, quietMs: 30*60*1000 }; }
  _reactiveState(){ return {userMood:this.userMood, moodSource:this.moodSource, presenceState:this.presenceState, quietMs:this.quietMs, events:this.getEvents()}; }
  _pickSupportedEmotion(p:string[]){ return this.pickSupportedEmotion(p); }
}
