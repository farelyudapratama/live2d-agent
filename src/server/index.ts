/**
 * server/index.ts — Bun server, full parity with server.js (1945 LOC).
 * No external deps except Bun.
 */
import { ConfigManager, queueJsonWrite, mergeEventsIntoConfig } from "../shared/config";
import { llmWithFallback, callLLM } from "../shared/llm-client";
import type { ChatMessage } from "../shared/types";
import { sanitizeMotionAsset } from "../client/animation/motion-dsl";
import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from "fs";
import { join, extname, dirname, relative, resolve, normalize, sep } from "path";
import { execSync } from "child_process";

const PORT = Number(process.env.PORT) || 8310;
const ROOT = import.meta.dir;
const STATIC = join(ROOT, "../../static");
const DATA = join(ROOT, "../../data");
const MODEL_DIR = join(DATA, "model");
const SHEETS_DIR = join(DATA, "sheets");
const MOTIONS_DIR = join(DATA, "motions");

const config = new ConfigManager(DATA);
for (const d of [DATA, SHEETS_DIR, MOTIONS_DIR, MODEL_DIR]) mkdirSync(d, { recursive: true });

const KNOWN_ROLES = ["angleX","angleY","angleZ","eyeBallX","eyeBallY","eyeLOpen","eyeROpen","eyeLSmile","eyeRSmile","eyeForm","mouthOpenY","mouthForm","mouthOpenX","bodyAngleX","bodyAngleY","bodyAngleZ","breath","browLForm","browRForm","browLY","browRY","browLAngle","browRAngle","blush"];

const MIME: Record<string,string> = {
  ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".json":"application/json; charset=utf-8", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg",
  ".gif":"image/gif", ".svg":"image/svg+xml", ".ico":"image/x-icon", ".moc3":"application/octet-stream",
  ".woff":"font/woff", ".woff2":"font/woff2", ".mp3":"audio/mpeg", ".wav":"audio/wav",
  ".model3.json":"application/json; charset=utf-8", ".physics3.json":"application/json; charset=utf-8",
  ".exp3.json":"application/json; charset=utf-8", ".cdi3.json":"application/json; charset=utf-8",
};

function json(data: unknown, status=200): Response {
  return new Response(JSON.stringify(data), { status, headers:{ "Content-Type":"application/json; charset=utf-8", "Access-Control-Allow-Origin":"*" } });
}
function cors(res: Response){ res.headers.set("Access-Control-Allow-Origin","*"); res.headers.set("Access-Control-Allow-Methods","POST, GET, PUT, DELETE, OPTIONS"); res.headers.set("Access-Control-Allow-Headers","Content-Type"); return res; }
async function readBody(req: Request): Promise<any>{ const t=await req.text(); try{ return JSON.parse(t);}catch{ return null; } }
function stripBom(s:string){ return s.charCodeAt(0)===0xFEFF? s.slice(1): s; }
function cleanStr(s:string){ return String(s||"").replace(/[\u0000-\u001F\u007F\u00A0\u200B-\u200D\uFEFF]+/g,"").trim(); }

// ── safe path ───────────────────────────────────────────────────
function safeJoinStatic(reqPath: string): string | null {
  let decoded: string;
  try{ decoded = decodeURIComponent(reqPath.split("?")[0]); } catch{ decoded = reqPath.split("?")[0]; }
  // normalize and prevent traversal
  const normalized = normalize(decoded).replace(/^(\.\.[\/\\])+/, "");
  // model files live under DATA, not STATIC
  if (normalized.startsWith("/model/") || normalized.startsWith("model/")) {
    const rel = normalized.replace(/^\/+/, "");
    const full = join(DATA, rel);
    if (!full.startsWith(DATA)) return null;
    return full;
  }
  const full = join(STATIC, normalized);
  if (!full.startsWith(STATIC) && !full.startsWith(DATA)) return null;
  // also allow DATA/model fallback
  if (existsSync(full)) return full;
  // try DATA/model for bare paths
  const alt = join(DATA, normalized.replace(/^\/+/,""));
  if (existsSync(alt)) return alt;
  return full;
}

function serveStatic(reqPath: string): Response | null {
  const fp = safeJoinStatic(reqPath);
  if (!fp || !existsSync(fp) || !statSync(fp).isFile()) return null;
  // detect mime by longest suffix
  let mime = "application/octet-stream";
  for (const ext of Object.keys(MIME).sort((a,b)=>b.length-a.length)) if (fp.toLowerCase().endsWith(ext)) { mime = MIME[ext]; break; }
  if (!mime || mime==="application/octet-stream") {
    const e = extname(fp).toLowerCase();
    mime = MIME[e] ?? mime;
  }
  return new Response(Bun.file(fp), { headers:{ "Content-Type": mime, "Cache-Control":"no-cache", "Access-Control-Allow-Origin":"*" } });
}

// ── helpers for model ───────────────────────────────────────────
function findModel3(rootDir: string, depth=0): string | null {
  let hit: string|null=null;
  try{
    for(const e of readdirSync(rootDir,{withFileTypes:true})){
      const full=join(rootDir,e.name);
      if(e.isDirectory()){ if(depth>6) continue; const r=findModel3(full,depth+1); if(r) return r; }
      else if(e.name.toLowerCase().endsWith(".model3.json")|| e.name.toLowerCase()==="model3.json") return full;
    }
  }catch{}
  return hit;
}
function findCdi3(rootDir:string, depth=0): string|null{
  try{ for(const e of readdirSync(rootDir,{withFileTypes:true})){ const full=join(rootDir,e.name); if(e.isDirectory()){ if(depth>6) continue; const r=findCdi3(full,depth+1); if(r) return r; } else if(e.name.toLowerCase().endsWith(".cdi3.json")) return full; } }catch{}
  return null;
}
function discoverExpressions(name:string){
  const dir=join(MODEL_DIR,name||"");
  if(!dir.startsWith(MODEL_DIR)||!existsSync(dir)) throw new Error("not found");
  const model3=findModel3(dir); if(!model3) throw new Error("no model3.json in folder");
  const baseDir=dirname(model3);
  let declared: string[]=[]; try{ const mj=JSON.parse(stripBom(readFileSync(model3,"utf8"))); const ex=mj?.FileReferences?.Expressions; if(Array.isArray(ex)) declared=ex.map((e:any)=>e&&e.File).filter(Boolean); }catch{}
  const declaredSet=new Set(declared.map(f=>String(f).split(sep).join("/")));
  const found:any[]=[];
  (function walk(d:string,depth:number){ if(depth>6) return; let entries:any[]=[]; try{ entries=readdirSync(d,{withFileTypes:true}); }catch{ return;} for(const e of entries){ const full=join(d,e.name); if(e.isDirectory()){ walk(full,depth+1); continue;} if(!e.name.toLowerCase().endsWith(".exp3.json")) continue; const rel=relative(baseDir,full).split(sep).join("/"); if(rel.startsWith("..")) continue; found.push({ Name:e.name.replace(/\.exp3\.json$/i,""), File:rel, declared:declaredSet.has(rel) }); } })(dir,0);
  found.sort((a,b)=>a.Name.localeCompare(b.Name));
  return { model3: relative(DATA,model3).split(sep).join("/"), declaredCount:declaredSet.size, expressions:found, orphanCount:found.filter(f=>!f.declared).length };
}
function sanitizeKey(name:string){ return (name||"default").replace(/[^A-Za-z0-9_\u4e00-\u9fff]/g,"_"); }
function sheetPathFor(name:string){ return join(SHEETS_DIR, sanitizeKey(name)+".json"); }
function filterAdoptable(onDisk:any[], disabled:any){
  const isOff=(n:string)=>{ if(disabled && typeof disabled.has==="function") return disabled.has(n); if(Array.isArray(disabled)) return disabled.indexOf(n)!==-1; return false; };
  return (Array.isArray(onDisk)?onDisk:[]).filter(e=>e && !e.declared && e.File && e.Name && !isOff(e.Name));
}

// ── MOTION helpers ──────────────────────────────────────────────
function motionsDirFor(modelKey:string){
  const dir=join(MOTIONS_DIR, sanitizeKey(modelKey));
  if(!dir.startsWith(MOTIONS_DIR)) throw new Error("model key tidak valid");
  mkdirSync(dir,{recursive:true}); return dir;
}
function motionFileFor(modelKey:string,id:string){
  if(!/^[A-Za-z0-9_\-]{1,60}$/.test(id||"")) throw new Error("motion id tidak valid");
  const file=join(motionsDirFor(modelKey), id+".motion.json");
  if(!file.startsWith(MOTIONS_DIR)) throw new Error("motion id tidak valid");
  return file;
}
function listMotions(modelKey:string){
  const dir=motionsDirFor(modelKey); const out:any[]=[]; let entries:string[]=[]; try{ entries=readdirSync(dir);}catch{ return out;} for(const f of entries){ if(!f.endsWith(".motion.json")) continue; try{ out.push(JSON.parse(stripBom(readFileSync(join(dir,f),"utf8")))); }catch{}} return out;
}

// ── API dispatcher ──────────────────────────────────────────────
async function handleAPI(req: Request): Promise<Response|null> {
  const url=new URL(req.url); const path=url.pathname; const method=req.method;

  // config
  if(method==="GET" && path==="/api/config"){
    const cfg=config.load(); const conns=cfg.connections.map(c=>{ const o={...c} as any; if(o.apiKey && !o.apiKey.startsWith("MASUKKAN")) o.apiKey=config.maskKey(o.apiKey); return o; });
    return json({ activeId:cfg.activeId, connections:conns, tts:cfg.tts||{}, events:cfg.events||{}, camera:cfg.camera||{}, motion:cfg.motion||{} });
  }
  if(method==="POST" && path==="/api/config") return handleConfigPost(req);
  if(method==="POST" && path==="/api/test") return handleTestConnection(req);
  if(method==="POST" && path==="/api/chat") return handleChat(req);
  if(method==="POST" && path==="/api/tts") return handleTTS(req);

  // classify-params / analyze-sheet / animate-text
  if(method==="POST" && path==="/api/model/classify-params") return handleClassifyParams(req);
  if(method==="POST" && path==="/api/model/analyze-sheet") return handleAnalyzeSheet(req);
  if(method==="POST" && path==="/api/animate-text") return handleAnimateText(req);

  // motions AI
  if(method==="POST" && path==="/api/motions/analyze") return handleMotionsAnalyze(req);
  if(method==="POST" && path==="/api/motions/generate") return handleMotionsGenerate(req);

  // sheet
  if(method==="POST" && path==="/api/sheet") return handleSheetPost(req);
  if(method==="GET" && path==="/api/sheet") return handleSheetGet(req);

  // model helpers
  if(method==="GET" && path==="/api/models") return handleListModels();
  if(method==="GET" && path==="/api/model/path") return handleModelPath(req);
  if(method==="GET" && path==="/api/model/expressions") return handleModelExpressions(req);
  if(method==="GET" && path==="/api/model/expressions-adoption") return handleAdoptionGet(req);
  if(method==="POST" && path==="/api/model/expressions-adoption") return handleAdoptionPost(req);
  if(method==="GET" && path==="/api/model/files") return handleModelFiles(req);
  if(method==="GET" && path==="/api/model/motion-taxonomy") return handleMotionTaxonomy(req);
  if(method==="POST" && path==="/api/model/import-zip") return handleImportZip(req);
  if(method==="POST" && path==="/api/model/upload") return handleModelUpload(req);
  if(method==="DELETE" && path.startsWith("/api/model/")) return handleModelDelete(req);

  // motions CRUD
  if(method==="GET" && path==="/api/motions") return handleListMotions(req);
  if(method==="POST" && path==="/api/motions") return handleMotionsPost(req);
  if(method==="PUT" && path.startsWith("/api/motions/")) return handleMotionsPut(req);
  if(method==="GET" && path.startsWith("/api/motions/")) return handleMotionsGet(req);
  if(method==="DELETE" && path.startsWith("/api/motions/")) return handleMotionsDelete(req);

  return null;
}

// ── handlers ────────────────────────────────────────────────────
async function handleConfigPost(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"body JSON rusak"},400);
  const action=body.action||"save"; const cfg=config.load(); let conns=[...(cfg.connections||[])];
  try{
    if(action==="add"){ const id="conn_"+Date.now().toString(36); const conn=Object.assign({id,testStatus:"idle",provider:"openai-compatible"} as any, body.connection||{}); conn.id=id; conns.push(conn); if(!cfg.activeId) cfg.activeId=id; }
    else if(action==="update"){ const i=conns.findIndex(c=>c.id===body.id); if(i<0) return json({error:"connection tidak ada"},404); const upd=body.connection||{}; if(!upd.apiKey||!String(upd.apiKey).trim()) upd.apiKey=conns[i].apiKey; conns[i]=Object.assign({},conns[i],upd); conns[i].id=body.id; }
    else if(action==="delete"){ conns=conns.filter(c=>c.id!==body.id); if(cfg.activeId===body.id) cfg.activeId=conns[0]?.id||null; }
    else if(action==="setActive"){ if(!conns.find(c=>c.id===body.id)) return json({error:"connection tidak ada"},404); cfg.activeId=body.id; }
    else if(action==="saveEvents"){ config.saveEvents(body.events||{}); return json({ok:true, events: config.load().events}); }
    else if(action==="save"){ if(Array.isArray(body.connections)) conns=body.connections; if(body.activeId) cfg.activeId=body.activeId; }
    else return json({error:"action tidak dikenal: "+action},400);
    for(const c of conns) if(c.apiKey) c.apiKey=cleanStr(c.apiKey);
    config.saveConnections(conns,cfg.activeId);
    return json({ok:true, activeId:cfg.activeId, connections:conns.length});
  }catch(e:any){ return json({error:"gagal menyimpan: "+e.message},500); }
}

async function handleChat(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"body JSON rusak"},400);
  const messages:ChatMessage[]=body.messages||[]; const clientSystem=body.system||"";
  try{
    const {reply,used}=await llmWithFallback(()=>config.connections,()=>config.activeConnection,(conns)=>config.saveConnections(conns, config.load().activeId), messages, clientSystem);
    return json({reply,used});
  }catch(e:any){ return json({error:e.message}, e.httpStatus||502); }
}

async function handleTestConnection(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"body JSON rusak"},400);
  const conn=body.connection||{}; const stored=config.connections.find(x=>x.id===conn.id); if(stored?.apiKey) conn.apiKey=stored.apiKey;
  if((conn.provider||"openai-compatible").toLowerCase()!=="mock" && (!conn.apiKey|| conn.apiKey.startsWith("MASUKKAN"))) return json({valid:false, error:"apiKey belum diisi"});
  try{ const reply=await callLLM(conn,[{role:"user",content:"Reply with just: OK"}]); return json({valid:true, reply:reply.slice(0,80)});}catch(e:any){ return json({valid:false, error:e.message}); }
}

async function handleTTS(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body?.text) return json({error:"no text"},400);
  const cfg=config.load(); const gradio=cfg.tts?.endpoint; if(!gradio) return json({error:"tts endpoint belum diisi"},400);
  try{
    const base=gradio.replace(/\/$/,"");
    const r1=await fetch(base+"/gradio_api/call/generate_api",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({data:[body.text]})});
    if(!r1.ok) throw new Error("gradio call HTTP "+r1.status);
    const ev=(await r1.json() as any).event_id;
    const r2=await fetch(base+"/gradio_api/call/generate_api/"+ev);
    const sse=await r2.text(); let audioUrl:string|null=null;
    for(const line of sse.split("\n").reverse()){ const ln=line.trim(); if(ln.startsWith("data:")){ const j=JSON.parse(ln.slice(5).trim()); const fd=Array.isArray(j)?j[0]:j; audioUrl=fd?.url ?? (fd?.path? base+"/gradio_api/file"+fd.path:null); break; } }
    if(!audioUrl) throw new Error("no audio url from gradio");
    if(!/^https?:/.test(audioUrl)) audioUrl=base+audioUrl;
    const audioResp=await fetch(audioUrl); const buf=Buffer.from(await audioResp.arrayBuffer());
    return new Response(buf,{headers:{"Content-Type": audioResp.headers.get("content-type")||"audio/wav"}});
  }catch(e:any){ return json({error:"TTS error: "+e.message},502); }
}

async function handleClassifyParams(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"body JSON rusak"},400);
  const unclassified=body.params||[]; const knownRoles=body.currentRoles||{};
  if(!unclassified.length) return json({classifications:[]});
  const active=config.activeConnection; if(!active) return json({classifications:[]});
  const prompt=`Kamu adalah pakar Live2D Cubism rigging & parameter modeling.
Berikut daftar parameter model yang BELUM memiliki mapping role baku:
${unclassified.map((u:any)=>`- ID: "${u.id}", Range: [${u.min}, ${u.max}], Default: ${u.def}`).join("\n")}

Parameter yang SUDAH ter-mapping:
${Object.entries(knownRoles).map(([r,id])=>`  ${r} -> ${id}`).join("\n")||"(belum ada)"}

Daftar semantic roles yang tersedia:
[${KNOWN_ROLES.join(", ")}]

TUGAS: Analisis setiap parameter di atas. Tentukan id, role (salah satu di atas atau null), group, label, isAccessory.
KEMBALIKAN HANYA JSON array valid tanpa markdown.
Format: [{ "id": "ParamX", "role": "angleX", "group": "Sudut (Angle)", "label": "Kepala X", "isAccessory": false }]`;
  try{
    const {reply}=await llmWithFallback(()=>config.connections,()=>config.activeConnection,(c)=>config.saveConnections(c,config.load().activeId), [{role:"user",content:prompt}]);
    let clean=reply.replace(/```json/gi,"").replace(/```/g,"").trim(); let parsed:any=[]; try{parsed=JSON.parse(clean);}catch{ const m=clean.match(/\[\s*\{[\s\S]*\}\s*\]/); if(m) try{parsed=JSON.parse(m[0]);}catch{}}
    const requestedIds=new Set(unclassified.map((u:any)=>String(u.id))); const allowedRoles=new Set(KNOWN_ROLES);
    const str=(v:any,cap:number)=> (typeof v==="string"? v.replace(/[\u0000-\u001F\u007F]/g,"").trim().slice(0,cap): "");
    const safe=(Array.isArray(parsed)?parsed:[]).reduce((acc:any[],it:any)=>{
      if(!it||typeof it!=="object") return acc; const id=String(it.id??""); if(!requestedIds.has(id)) return acc;
      const role= typeof it.role==="string" && allowedRoles.has(it.role)? it.role: null;
      acc.push({ id, role, group:str(it.group,40), label:str(it.label,60), isAccessory: it.isAccessory===true }); return acc;
    },[]);
    return json({classifications:safe});
  }catch(e:any){ console.warn("[classify-params]",e.message); return json({classifications:[], warning:e.message}); }
}

async function handleAnalyzeSheet(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"body JSON rusak"},400);
  const params=(Array.isArray(body.params)?body.params:[]).filter((p:any)=>p&&typeof p.id==="string"&&p.id&&Number.isFinite(Number(p.min))&&Number.isFinite(Number(p.max))).slice(0,300);
  const parts=(Array.isArray(body.parts)?body.parts:[]).map((p:any)=>(p&&typeof p==="object")?p.id:p).filter((p:any)=>typeof p==="string"&&p).slice(0,300);
  const existing=(Array.isArray(body.existingNames)?body.existingNames:[]).filter((n:any)=>typeof n==="string").map((n:string)=>n.toLowerCase()).slice(0,400);
  const CATS=["emosi","properti","aksesoris"];
  const notes=(body.notes&&typeof body.notes==="object")?body.notes:{}; const noteOf=(id:string)=>{ const n=(notes as any)[id]; if(typeof n!=="string") return ""; return n.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,"").trim().slice(0,300); };
  if(!params.length) return json({presets:[], warning:"tidak ada parameter dengan range valid"});
  if(!config.activeConnection) return json({presets:[], warning:"tidak ada koneksi AI aktif"});
  const paramLines=params.map((p:any)=>{ const label= typeof p.label==="string"&&p.label.trim()? ` (${p.label.trim().slice(0,40)})`:""; let line=`- "${p.id}"${label} range [${Number(p.min)}, ${Number(p.max)}] default ${Number(p.def)}`; const pn=noteOf(p.id); if(pn) line+=` | penjelasan user: ${pn}`; return line; }).join("\n");
  const prompt=`Kamu pakar rigging Live2D Cubism. Berdasarkan daftar parameter model di bawah, usulkan preset pose yang masuk akal dan SEBANYAK MUNGKIN VARIASI untuk model INI.

PARAMETER TERSEDIA (hanya id di bawah yang boleh dipakai):
${paramLines}

${parts.length? `PART TERSEDIA (opacity 0..1):\n${parts.map((p:string)=>`- "${p}"`).join("\n")}`:"(model ini tidak punya part yang bisa di-toggle — semua efek harus lewat PARAMETER di atas)"}

PRESET YANG SUDAH ADA (jangan diusulkan ulang):
${existing.length? existing.join(", "):"(belum ada)"}

TUGAS: usulkan MINIMAL 12 preset yang BERAGAM, menyentuh sebanyak mungkin grup parameter.
Untuk tiap preset: name (max 60), category (${CATS.join(" / ")}), values: { ParamId: angka }, parts: { PartId: 0..1 }

ATURAN: JANGAN mengarang id, JANGAN sertakan min/max/def/steps, hanya 3-8 param per preset, kategori "gerak" DIBUANG, WAJIB BERAGAM (minimal 6 emosi berbeda + campuran properti/aksesoris).
KEMBALIKAN HANYA JSON array valid tanpa markdown.
Format: [{ "name": "Senang", "category": "emosi", "values": { "ParamMouthForm": 1 }, "parts": {} }]`;
  try{
    const {reply}=await llmWithFallback(()=>config.connections,()=>config.activeConnection,(c)=>config.saveConnections(c,config.load().activeId), [{role:"user",content:prompt}]);
    let clean=reply.replace(/```json/gi,"").replace(/```/g,"").trim(); let parsed:any=[]; try{parsed=JSON.parse(clean);}catch{ const m=clean.match(/\[\s*\{[\s\S]*\}\s*\]/); if(m) try{parsed=JSON.parse(m[0]);}catch{}}
    const ranges=new Map(params.map((p:any)=>[p.id,{lo:Number(p.min),hi:Number(p.max)}])); const partIds=new Set(parts); const existingSet=new Set(existing);
    const str=(v:any,cap:number)=> (typeof v==="string"? v.replace(/[\u0000-\u001F\u007F]/g,"").trim().slice(0,cap): "");
    const seen=new Set<string>(); let dropped=0;
    const safe=(Array.isArray(parsed)?parsed:[]).reduce((acc:any[],it:any)=>{
      if(!it||typeof it!=="object"||Array.isArray(it)){dropped++;return acc;}
      const name=str(it.name,60); const category=CATS.includes(it.category)? it.category:null;
      if(!name||!category){dropped++;return acc;}
      const key=category+"\u0000"+name.toLowerCase(); if(existingSet.has(name.toLowerCase())||seen.has(key)){dropped++;return acc;}
      const values:Record<string,number>={};
      if(it.values&&typeof it.values==="object"&&!Array.isArray(it.values)){ for(const k of Object.keys(it.values)){ const r=ranges.get(k); const n=Number((it.values as any)[k]); if(!r||!Number.isFinite(n)) continue; values[k]=Math.max(r.lo, Math.min(r.hi,n)); } }
      const pparts:Record<string,number>={};
      if(it.parts&&typeof it.parts==="object"&&!Array.isArray(it.parts)){ for(const k of Object.keys(it.parts)){ const n=Number((it.parts as any)[k]); if(!partIds.has(k)||!Number.isFinite(n)) continue; pparts[k]=Math.max(0,Math.min(1,n)); } }
      if(!Object.keys(values).length && !Object.keys(pparts).length){dropped++;return acc;}
      seen.add(key); acc.push({name,category,values,parts:pparts,source:"ai"}); return acc;
    },[]).slice(0,12);
    if(dropped) console.warn("[analyze-sheet] dropped",dropped);
    return json({presets:safe});
  }catch(e:any){ console.warn("[analyze-sheet]",e.message); return json({presets:[], warning:e.message}); }
}

async function handleAnimateText(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"body JSON rusak"},400);
  const text=(body.text||"").trim(); const caps=body.capabilities||{};
  const emotions=(caps.emotions&&caps.emotions.length)?caps.emotions:["senang","sedih","malu","kaget","normal"];
  const gestures=(caps.gestures&&caps.gestures.length)?caps.gestures:["nod","shake","tilt_curious","lean_excited","recoil_surprised","look_away_shy","laugh_bounce","think","wave_hi"];
  const motions=Array.isArray(caps.motions)? caps.motions.filter((m:any)=>m&&m.id):[];
  if(!text) return json({segments:[]});
  if(!config.activeConnection) return json({segments:[{text,emotion:"normal",gesture:"nod",intensity:0.7}]});
  const directorPrompt=`Kamu adalah animation director untuk karakter Live2D Anime yang hidup dan ekspresif.
Karakter baru saja berbicara teks berikut:
"${text}"

Daftar Emosi yang didukung model: [${emotions.join(", ")}]
Daftar Gesture yang tersedia: [${gestures.join(", ")}]
${motions.length? "Gerakan buatan user (Motion Studio) — pakai field \"motion\" dengan id PERSIS:\n"+motions.slice(0,24).map((m:any)=>"- "+m.id+": "+(m.description||m.id)+(m.compatibleEmotions&&m.compatibleEmotions.length? " (cocok saat: "+m.compatibleEmotions.join(", ")+")":"")).join("\n")+"\nGerakan ini dirancang user sendiri; utamakan bila maknanya pas. Jangan mengarang id.\n":""}
TUGAS:
1. Pecah teks di atas menjadi beberapa segment (per klausa atau per kalimat) agar karakter bergerak seirama omongannya secara hidup.
2. Untuk setiap segment, tentukan: "text", "emotion", "gesture" (atau null)${motions.length?', "motion"':''}, "intensity" 0.3..1.0
KEMBALIKAN HANYA JSON array valid tanpa markdown.
Contoh: [{ "text": "Halo semuanya!", "emotion": "senang", "gesture": "wave_hi", "intensity": 0.9 }]`;
  try{
    const {reply}=await llmWithFallback(()=>config.connections,()=>config.activeConnection,(c)=>config.saveConnections(c,config.load().activeId), [{role:"user",content:directorPrompt}]);
    let clean=reply.replace(/```json/gi,"").replace(/```/g,"").trim(); let parsed:any=[]; try{parsed=JSON.parse(clean);}catch{ const m=clean.match(/\[\s*\{[\s\S]*\}\s*\]/); if(m) try{parsed=JSON.parse(m[0]);}catch{}}
    const okEmotion=new Set(emotions); const okGesture=new Set(gestures); const okMotion=new Set(motions.map((m:any)=>m.id));
    const segments=(Array.isArray(parsed)?parsed:[]).reduce((acc:any[],s:any)=>{
      if(!s||typeof s!=="object") return acc; const t=typeof s.text==="string"? s.text:""; if(!t.trim()) return acc;
      let inten=Number(s.intensity); if(!Number.isFinite(inten)) inten=0.7;
      acc.push({ text:t, emotion: okEmotion.has(s.emotion)? s.emotion:"normal", gesture: okGesture.has(s.gesture)? s.gesture:null, motion: okMotion.has(s.motion)? s.motion:null, intensity: Math.min(1.0,Math.max(0.3,inten)) });
      return acc;
    },[]);
    return json({segments: segments.length? segments:[{text,emotion:"normal",gesture:"nod",intensity:0.7}]});
  }catch(e:any){ console.warn("[animate-text]",e.message); return json({segments:[{text,emotion:"normal",gesture:"nod",intensity:0.7}]}); }
}

async function handleMotionsAnalyze(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"body JSON rusak"},400);
  const m=body.motion||{}; const emotions= Array.isArray(body.emotions)&&body.emotions.length? body.emotions.slice(0,12).map(String):["senang","sedih","malu","kaget","normal"];
  const tracks=(Array.isArray(m.tracks)?m.tracks:[]).map((tr:any)=>{ const vals=(tr.keys||[]).map((k:any)=>Number(k.v)).filter(Number.isFinite); return { target: tr.label||tr.param||tr.target||tr.field, range: vals.length? [Math.min(...vals),Math.max(...vals)]:[0,0], keyframes:(tr.keys||[]).length }; }).filter((t:any)=>t.target);
  if(!tracks.length) return json({error:"motion tanpa track"},400);
  if(!config.activeConnection) return json({error:"belum ada koneksi AI aktif"},503);
  const prompt=`Kamu menganalisa satu gerakan (motion) karakter Live2D.
Data gerakan:
durasi: ${Number(m.duration)||1} detik
${tracks.map((t:any)=>`- ${t.target}: rentang ${t.range[0]}..${t.range[1]}, ${t.keyframes} keyframe`).join("\n")}
TUGAS: tebak gerakan ini menyampaikan apa, balas JSON: { "description": "satu kalimat id max 120", "tags": ["3-5 tag"], "emotionCompatibility": { "<emosi>": 0.0-1.0 } }
Emosi yang boleh dipakai HANYA: [${emotions.join(", ")}]
KEMBALIKAN HANYA JSON tanpa markdown.`;
  try{
    const {reply}=await llmWithFallback(()=>config.connections,()=>config.activeConnection,(c)=>config.saveConnections(c,config.load().activeId), [{role:"user",content:prompt}]);
    let clean=String(reply||"").replace(/```json/gi,"").replace(/```/g,"").trim(); let parsed:any=null; try{parsed=JSON.parse(clean);}catch{ const mm=clean.match(/\{[\s\S]*\}/); if(mm) try{parsed=JSON.parse(mm[0]);}catch{}}
    if(!parsed||typeof parsed!=="object") return json({warning:"AI tidak mengembalikan JSON valid"});
    const okEmo=new Set(emotions); const emo:Record<string,number>={};
    if(parsed.emotionCompatibility&&typeof parsed.emotionCompatibility==="object"){ for(const [k,v] of Object.entries(parsed.emotionCompatibility as Record<string,unknown>)){ const n=Number(v); if(!okEmo.has(k)||!Number.isFinite(n)) continue; emo[k]=Math.max(0,Math.min(1,n)); } }
    const tags=Array.isArray(parsed.tags)? parsed.tags.slice(0,5).map((t:any)=>String(t).trim().toLowerCase().slice(0,30)).filter(Boolean):[];
    return json({description:String(parsed.description||"").trim().slice(0,200), tags, emotionCompatibility:emo, source:"ai"});
  }catch(e:any){ console.warn("[motions/analyze]",e.message); return json({warning:e.message}); }
}

async function handleMotionsGenerate(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"body JSON rusak"},400);
  const desc=String(body.prompt||"").trim().slice(0,300); if(!desc) return json({error:"prompt kosong"},400);
  const emotions= Array.isArray(body.emotions)&&body.emotions.length? body.emotions.slice(0,12).map(String):["senang","sedih","malu","kaget","normal"];
  if(!config.activeConnection) return json({error:"belum ada koneksi AI aktif"},503);
  const prompt=`Kamu membuat gerakan (motion) untuk karakter Live2D dari deskripsi user.
Permintaan user: "${desc}"
HANYA boleh memakai track: ax(kepala kiri/kanan ±30), ay(atas/bawah ±30), bodyZ(miring ±30), bodyX/Y(geser ±30), ex/ey(bola mata -1..1), mouthForm(-1..1)
JANGAN menyebut Param... Aturan: maksimal 4 track, 6 keyframe per track, t mulai 0, durasi 0.6..3s, gerakan pulang ke 0 di keyframe terakhir.
Balas JSON: { "id": "snake_case", "name": "Nama", "description": "satu kalimat", "tags": ["2-4 tag"], "duration": 1.4, "emotionCompatibility": {"<emosi>":0..1}, "tracks": [{ "target": "ay", "keys": [{ "t":0,"v":0 },{"t":0.4,"v":8},{"t":1.4,"v":0}] }] }
Emosi HANYA: [${emotions.join(", ")}]
KEMBALIKAN HANYA JSON tanpa markdown.`;
  try{
    const {reply}=await llmWithFallback(()=>config.connections,()=>config.activeConnection,(c)=>config.saveConnections(c,config.load().activeId), [{role:"user",content:prompt}]);
    let clean=String(reply||"").replace(/```json/gi,"").replace(/```/g,"").trim(); let parsed:any=null; try{parsed=JSON.parse(clean);}catch{ const mm=clean.match(/\{[\s\S]*\}/); if(mm) try{parsed=JSON.parse(mm[0]);}catch{}}
    if(!parsed||typeof parsed!=="object") return json({error:"AI tidak mengembalikan JSON valid"});
    if(parsed.emotionCompatibility&&typeof parsed.emotionCompatibility==="object"){ const okEmo=new Set(emotions); for(const k of Object.keys(parsed.emotionCompatibility)) if(!okEmo.has(k)) delete (parsed.emotionCompatibility as any)[k]; }
    parsed.id=String(parsed.id||desc).toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,60)||"gerakan_ai";
    const r=sanitizeMotionAsset(parsed,{requireTracks:true, source:"user"} as any);
    if(!r.ok) return json({error:"hasil AI tidak valid: "+(r as any).errors.join("; ")});
    return json({motion:(r as any).asset, source:"ai"});
  }catch(e:any){ console.warn("[motions/generate]",e.message); return json({error:e.message}); }
}

// ── sheet ───────────────────────────────────────────────────────
async function handleSheetPost(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"sheet kosong"},400);
  const name=(body.modelName||"default"); const sheet=body.sheet||body;
  if(!sheet||typeof sheet!=="object"||Array.isArray(sheet)) return json({error:"sheet kosong"},400);
  const target=sheetPathFor(name);
  try{ await queueJsonWrite(target, sheet); console.log("[server] character sheet saved ->", target); return json({ok:true, path:relative(DATA,target).split(sep).join("/")}); }catch(e:any){ return json({error:e.message},500); }
}
async function handleSheetGet(req:Request):Promise<Response>{
  const name=new URL(req.url).searchParams.get("name")||"default"; const p=sheetPathFor(name);
  if(!existsSync(p)) return json({error:"no sheet"},404);
  try{ const raw=readFileSync(p,"utf8"); return new Response(raw,{headers:{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*"}});}catch(e:any){ return json({error:e.message},500); }
}

// ── models ──────────────────────────────────────────────────────
function handleListModels():Response{
  try{
    if(!existsSync(MODEL_DIR)) mkdirSync(MODEL_DIR,{recursive:true});
    const folders=readdirSync(MODEL_DIR,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name).filter(name=>{ const dir=join(MODEL_DIR,name); try{ return !!findModel3(dir);}catch{return false;}}).sort();
    return json({models:folders});
  }catch(e:any){ return json({error:e.message},500); }
}
function handleModelPath(req:Request):Response{
  try{
    const name=new URL(req.url).searchParams.get("name"); const dir=join(MODEL_DIR,name||"");
    if(!dir.startsWith(MODEL_DIR)||!existsSync(dir)) throw new Error("not found");
    const abs=findModel3(dir); if(!abs) throw new Error("no model3.json in folder");
    const rel=relative(DATA,abs).split(sep).join("/"); return json({path:rel});
  }catch(e:any){ return json({error:e.message},404); }
}
function handleModelExpressions(req:Request):Response{
  try{ const info=discoverExpressions(new URL(req.url).searchParams.get("name")||""); return json(info);}catch(e:any){ return json({error:e.message},404); }
}
function handleAdoptionGet(req:Request):Response{
  try{
    const name=new URL(req.url).searchParams.get("name")||""; const info=discoverExpressions(name);
    const adoptFile=join(SHEETS_DIR,"exp3-adoption_"+String(name||"").replace(/[^A-Za-z0-9_\-]+/g,"_")+".json");
    let disabled:string[]=[]; try{ const j=JSON.parse(readFileSync(adoptFile,"utf8")); if(Array.isArray(j.disabled)) disabled=j.disabled;}catch{}
    const disabledSet=new Set(disabled); const expressions=(info.expressions||[]).map((e:any)=>Object.assign({},e,{enabled:!disabledSet.has(e.Name)}));
    return json({model3:info.model3, expressions, disabled:Array.from(disabledSet)});
  }catch(e:any){ return json({error:e.message},404); }
}
async function handleAdoptionPost(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"body JSON rusak"},400);
  try{
    const name=String(body.name||"").replace(/[^A-Za-z0-9_\-]+/g,"_"); if(!name) throw new Error("name kosong");
    const disabled=Array.isArray(body.disabled)? body.disabled.filter((x:any)=>typeof x==="string"):[]; const adoptFile=join(SHEETS_DIR,"exp3-adoption_"+name+".json");
    await queueJsonWrite(adoptFile,{disabled}); return json({ok:true, disabled});
  }catch(e:any){ return json({error:e.message},500); }
}
function handleModelFiles(req:Request):Response{
  try{
    const name=new URL(req.url).searchParams.get("name"); const dir=join(MODEL_DIR,name||"");
    if(!dir.startsWith(MODEL_DIR)||!existsSync(dir)) return json({error:"not found"},404);
    const out:string[]=[]; (function walk(d:string,rel:string){ for(const e of readdirSync(d,{withFileTypes:true})){ const full=join(d,e.name); const r=rel?rel+"/"+e.name:e.name; if(e.isDirectory()) walk(full,r); else out.push(r); } })(dir,"");
    return json({name:name||"", files:out});
  }catch(e:any){ return json({error:e.message},500); }
}
function handleMotionTaxonomy(req:Request):Response{
  try{
    const q=new URL(req.url).searchParams; const name=q.get("name")||""; const force=q.get("force")==="1";
    const dir=join(MODEL_DIR,name); if(!dir.startsWith(MODEL_DIR)||!existsSync(dir)) throw new Error("model not found");
    const cacheFile=join(SHEETS_DIR, sanitizeKey(name)+".motions.json");
    if(!force && existsSync(cacheFile)) return new Response(readFileSync(cacheFile,"utf8"),{headers:{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*"}});
    const clips:{file:string;abs:string}[]=[];
    (function walk(d:string,rel:string){ for(const e of readdirSync(d,{withFileTypes:true})){ const full=join(d,e.name); const r=rel?rel+"/"+e.name:e.name; if(e.isDirectory()) walk(full,r); else if(/\.motion3\.json$/i.test(e.name)) clips.push({file:r,abs:full}); } })(dir,"");
    const groupOf:Record<string,{group:string;index:number}>= {};
    try{ const m3=findModel3(dir); if(m3){ const j=JSON.parse(readFileSync(m3,"utf8")); const motions=(j.FileReferences&&j.FileReferences.Motions)||{}; const m3dir=dirname(m3); for(const g in motions){ (motions[g]||[]).forEach((entry:any,idx:number)=>{ if(!entry||!entry.File) return; const abs=resolve(m3dir,entry.File); groupOf[abs]={group:g,index:idx}; }); } } }catch{}
    // dynamic import taxonomy if available
    let taxo:any=null; try{ taxo=require(join(ROOT,"../../js/motion-taxonomy.js")); }catch{ try{ taxo=require("../../../live2d-agent/js/motion-taxonomy.js"); }catch{ taxo=null; } }
    let roleMap:any=null;
    try{ const cdi3Path=findCdi3(dir); if(cdi3Path && taxo?.buildRoleMap){ const built=taxo.buildRoleMap(JSON.parse(readFileSync(cdi3Path,"utf8"))); roleMap=built.map; } }catch{}
    const input:any[]=[];
    for(const c of clips){ let motion3:any=null; try{ motion3=JSON.parse(readFileSync(c.abs,"utf8"));}catch{} const g=groupOf[resolve(c.abs)]; input.push({name: g?g.group: c.file.replace(/\.motion3\.json$/i,"").split("/").pop(), group:g?g.group:null, index:g?g.index:null, file:c.file, motion3}); }
    let built:any={ clips:[], byVerb:{}, stats:{} };
    if(taxo?.buildTaxonomy) built=taxo.buildTaxonomy(input, roleMap);
    else { built.clips=input.map((c:any)=>({name:c.name, verb:"neutral"})); }
    built.clips=built.clips.map((entry:any,i:number)=>Object.assign({},entry,{group:input[i].group, index:input[i].index, file:input[i].file}));
    const payload={model:name, generatedAt:new Date().toISOString(), clipCount:input.length, ...built};
    try{ queueJsonWrite(cacheFile,payload).catch((e:any)=>console.warn("[motion-taxonomy] cache write failed",e.message)); }catch{}
    return json(payload);
  }catch(e:any){ return json({error:e.message},400); }
}
async function handleImportZip(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"zip kosong"},400);
  try{
    const name=body.name; const base64=body.base64; if(!base64) throw new Error("zip kosong");
    const clean=(name||"").trim().replace(/[^A-Za-z0-9_\-]+/g,"_")||("model_"+Date.now().toString(36));
    const dest=join(MODEL_DIR,clean); mkdirSync(dest,{recursive:true});
    const zipPath=join(dest,"_upload.zip"); writeFileSync(zipPath, Buffer.from(base64,"base64"));
    try{ execSync(`unzip -o -q "${zipPath}" -d "${dest}"`,{stdio:"ignore"});}catch(e:any){ try{ execSync(`powershell -NoProfile -Command "Expand-Archive -Force '${zipPath.replace(/'/g,"''")}' '${dest.replace(/'/g,"''")}'"`,{stdio:"ignore"});}catch(e2:any){ throw new Error("gagal extract zip: "+(e2.message||e.message)); } }
    const abs=findModel3(dest); if(!abs) throw new Error("zip tidak mengandung *.model3.json");
    const rel=relative(DATA,abs).split(sep).join("/"); try{ unlinkSync(zipPath);}catch{}
    return json({ok:true, name:clean, path:rel});
  }catch(e:any){ return json({error:e.message},400); }
}
async function handleModelUpload(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"body JSON rusak"},400);
  try{
    const name=body.name; const files=body.files;
    if(!name||!/^[^/\\.\s][^/\\]*$/.test(name)) throw new Error("nama model invalid");
    if(!Array.isArray(files)||!files.length) throw new Error("tidak ada file");
    const dest=join(MODEL_DIR,name); mkdirSync(dest,{recursive:true});
    let wroteModel3=false;
    for(const f of files){
      const rel=normalize(f.path||"").replace(/^(\.\.[\/\\])+/, ""); if(!rel||rel.startsWith("..")||/^[\/\\]/.test(rel)) continue;
      if(/model3\.json$/i.test(rel)) wroteModel3=true;
      const target=join(dest,rel); if(!target.startsWith(dest)) continue;
      mkdirSync(dirname(target),{recursive:true}); writeFileSync(target, Buffer.from(f.base64||"","base64"));
    }
    if(!wroteModel3) throw new Error("folder tidak mengandung *.model3.json");
    return json({ok:true, name});
  }catch(e:any){ return json({error:e.message},400); }
}
function handleModelDelete(req:Request):Response{
  const url=new URL(req.url); const name=decodeURIComponent(url.pathname.slice("/api/model/".length));
  try{ const dir=join(MODEL_DIR,name); if(!dir.startsWith(MODEL_DIR)||!existsSync(dir)) throw new Error("not found"); rmSync(dir,{recursive:true, force:true}); return json({ok:true}); }catch(e:any){ return json({error:e.message},400); }
}

// ── motions CRUD ────────────────────────────────────────────────
function handleListMotions(req:Request):Response{
  const model=new URL(req.url).searchParams.get("model")||"default"; const motions=listMotions(model); return json({motions});
}
async function handleMotionsPost(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"body JSON rusak"},400);
  try{
    const modelKey=body.model||"default"; const raw=body.motion||body;
    const sanitized=sanitizeMotionAsset(raw,{requireTracks:true, source:"user", sourceModelId: raw.sourceModelId||modelKey});
    if(!sanitized.ok) throw new Error("motion invalid: "+(sanitized as any).errors.join("; "));
    const asset=(sanitized as any).asset; const file=motionFileFor(modelKey,asset.id);
    if(existsSync(file)) return json({error:`motion "${asset.id}" sudah ada. Pakai nama lain atau Simpan (timpa).`},409);
    await queueJsonWrite(file,asset); console.log("[motions] saved ->", relative(DATA,file).split(sep).join("/"));
    return json({ok:true, motion:asset});
  }catch(e:any){ return json({error:e.message},400); }
}
async function handleMotionsPut(req:Request):Promise<Response>{
  const url=new URL(req.url); const id=decodeURIComponent(url.pathname.slice("/api/motions/".length));
  const body=await readBody(req); if(!body) return json({error:"body JSON rusak"},400);
  try{
    const modelKey=body.model||"default"; const raw=body.motion||body;
    const sanitized=sanitizeMotionAsset(Object.assign({},raw,{id}),{requireTracks:true, source:"user", sourceModelId: raw.sourceModelId||modelKey});
    if(!sanitized.ok) throw new Error("motion invalid: "+(sanitized as any).errors.join("; "));
    const asset=(sanitized as any).asset; const file=motionFileFor(modelKey,id);
    await queueJsonWrite(file,asset); console.log("[motions] updated ->", relative(DATA,file).split(sep).join("/"));
    return json({ok:true, motion:asset});
  }catch(e:any){ return json({error:e.message},400); }
}
function handleMotionsGet(req:Request):Response{
  try{
    const url=new URL(req.url); const id=decodeURIComponent(url.pathname.slice("/api/motions/".length).split("?")[0]);
    const model=url.searchParams.get("model")||"default"; const file=motionFileFor(model,id);
    if(!existsSync(file)) return json({error:"not found"},404);
    return new Response(stripBom(readFileSync(file,"utf8")),{headers:{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*"}});
  }catch(e:any){ return json({error:e.message},400); }
}
function handleMotionsDelete(req:Request):Response{
  try{
    const url=new URL(req.url); const raw=url.pathname.slice("/api/motions/".length).split("?")[0]; const id=decodeURIComponent(raw);
    const model=url.searchParams.get("model")||"default"; const file=motionFileFor(model,id);
    if(!existsSync(file)) throw new Error("not found"); unlinkSync(file); return json({ok:true});
  }catch(e:any){ return json({error:e.message},400); }
}

// legacy wrappers for servercompat (handleAPI expects them)
async function handleListMotionsLegacy(req:Request):Promise<Response>{ return handleListMotions(req); }
async function handleSaveMotion(req:Request):Promise<Response>{ return handleMotionsPost(req); }
function handleDeleteMotion(pathStr:string):Response{
  const id=decodeURIComponent(pathStr.split("/api/motions/")[1]||""); const file=motionFileFor("default",id);
  try{ if(existsSync(file)) unlinkSync(file); return json({ok:true}); }catch(e:any){ return json({error:e.message},500); }
}
function handleListModelsLegacy():Response{ return handleListModels(); }
function handleModelInfo(pathStr:string):Response{ const req=new Request("http://x"+pathStr); return handleModelPath(req); }

// ── start server (only when run directly, not when imported for type-check) ─
export { handleAPI, serveStatic, config };
let server: ReturnType<typeof Bun.serve> | null = null;
if (import.meta.main) {
server = Bun.serve({
  port: PORT,
  async fetch(req){
    if(req.method==="OPTIONS") return cors(new Response(null,{status:204}));
    const url=new URL(req.url); let pathname=url.pathname;
    // api first
    const apiResp=await handleAPI(req);
    if(apiResp) return apiResp;
    if(pathname==="/") pathname="/index.html";
    const staticResp=serveStatic(pathname);
    if(staticResp) return staticResp;
    // SPA fallback: try index.html
    const fallback=serveStatic("/index.html");
    if(fallback) return fallback;
    return new Response("Not Found",{status:404});
  }
});

console.log(`
╔══════════════════════════════════════════════╗
║  🎭 Live2D Agent v2 — Bun Server            ║
║  http://127.0.0.1:${PORT}                    ║
╚══════════════════════════════════════════════╝
`);
} // end if import.meta.main
