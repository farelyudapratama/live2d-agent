/**
 * server/index.ts — Bun server, full parity with server.js (1945 LOC).
 * No external deps except Bun.
 */
import { ConfigManager, queueJsonWrite, mergeEventsIntoConfig } from "../shared/config";
import { llmWithFallback, callLLM, llmForRole, normalizeRoles } from "../shared/llm-client";
import type { ChatMessage } from "../shared/types";
import { sanitizeMotionAsset } from "../client/animation/motion-dsl";
import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from "fs";
import { join, extname, dirname, relative, resolve, normalize, sep } from "path";
import { execSync } from "child_process";
// Motion taxonomy: modul TS milik v2 (src/client/engine/motion-taxonomy.ts),
// dipakai bersama oleh server & bundle browser. No dependency on the
// v1 sibling repo — the server must be self-contained.
// @ts-ignore — modul TS client, dipakai bareng oleh server & bundle browser
import * as MotionTaxonomy from "../client/engine/motion-taxonomy";
import { buildRescueBlueprint, RESCUE_FILENAME } from "./rescue";

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

// Body-size caps (v1 parity). v1 menghancurkan socket body yang kelebihan
// batas; di sini kita lempar BodyTooLargeError yang dijawab 413 JSON supaya
// client dapat error yang terbaca. Tabel batas = batas v1 per endpoint.
class BodyTooLargeError extends Error {}
function bodyLimitFor(path: string): number {
  if (path === "/api/model/import-zip") return 500 * 1024 * 1024;
  if (path === "/api/model/upload") return 200 * 1024 * 1024;
  if (path === "/api/sheet") return 5 * 1024 * 1024;
  if (path === "/api/config" || path === "/api/test" || path === "/api/model/expressions-adoption") return 100 * 1024;
  return 1024 * 1024; // chat, classify, analyze-sheet, animate-text, motions, tts
}
async function readBody(req: Request): Promise<any> {
  const max = bodyLimitFor(new URL(req.url).pathname);
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > max) throw new BodyTooLargeError("body terlalu besar (maks " + max + " bytes)");
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch {} throw new BodyTooLargeError("body terlalu besar (maks " + max + " bytes)"); }
    chunks.push(value);
  }
  const buf = new Uint8Array(total); let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  const t = new TextDecoder().decode(buf);
  try { return JSON.parse(t); } catch { return null; }
}
function stripBom(s:string){ return s.charCodeAt(0)===0xFEFF? s.slice(1): s; }
function cleanStr(s:string){ return String(s||"").replace(/[\u0000-\u001F\u007F\u00A0\u200B-\u200D\uFEFF]+/g,"").trim(); }

// ── safe path ───────────────────────────────────────────────────
// Resolve path statis dengan proteksi traversal. Hasil:
//   { file: string, forbidden: false } — ok
//   { file: null, forbidden: false }   — tidak ada (boleh SPA fallback)
//   { file: null, forbidden: true }    — traversal / file sensitif → 403
const SENSITIVE_FILES = new Set(["config.json", "config.json.bak"]); // berisi apiKey plaintext
function safeJoinStatic(reqPath: string): { file: string | null; forbidden: boolean } {
  let decoded: string;
  try{ decoded = decodeURIComponent(reqPath.split("?")[0]); } catch{ decoded = reqPath.split("?")[0]; }
  const normalized = normalize(decoded); // separator platform
  // Cek ".." pada path DECODED (sebelum normalize): di Windows normalize
  // menciutkan ".." root-relatif ("\\..\\x" → "\\x"), jadi pengecekan sesudah
  // normalize bisa lolos. URL statis yang sah tidak pernah punya segmen "..".
  const hasDotDot = (s: string) => s.split(/[\\/]/).includes("..");
  if (hasDotDot(decoded) || hasDotDot(normalized)) return { file: null, forbidden: true };
  const rel = normalized.replace(/^[\\/]+/, "");
  const resolveUnder = (base: string, r: string): string | null => {
    const full = normalize(join(base, r));
    return full === base || full.startsWith(base + sep) ? full : null;
  };
  // model files live under DATA, not STATIC
  if (/^model[\\/]/.test(rel)) {
    const full = resolveUnder(DATA, rel);
    return full ? { file: full, forbidden: false } : { file: null, forbidden: true };
  }
  // config.json / .bak menyimpan apiKey plaintext — tidak boleh disajikan statis
  if (SENSITIVE_FILES.has(rel)) return { file: null, forbidden: true };
  const full = resolveUnder(STATIC, rel);
  if (!full) return { file: null, forbidden: true };
  if (existsSync(full)) return { file: full, forbidden: false };
  // DATA fallback untuk path polos yang tak ada di STATIC
  const alt = resolveUnder(DATA, rel);
  if (alt && existsSync(alt)) return { file: alt, forbidden: false };
  return { file: full, forbidden: false };
}

function serveStatic(reqPath: string): Response | null {
  const r = safeJoinStatic(reqPath);
  if (r.forbidden) return new Response("Forbidden", { status: 403, headers:{ "Access-Control-Allow-Origin":"*" } });
  const fp = r.file;
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
  let model3=findModel3(dir);
  // Auto-Rescue: folder tanpa manifest — pakai blueprint rakitan sebagai daftar ekspresi.
  if(!model3){ const bp=buildRescueBlueprint(dir); if(!bp) throw new Error("no model3.json in folder");
    const ex=(bp.manifest.FileReferences.Expressions||[]).map((e:any)=>({ Name:e.Name, File:e.File, declared:true }));
    return { model3: "model/"+(name||"")+"/"+RESCUE_FILENAME, declaredCount: ex.length, expressions: ex, orphanCount: 0 }; }
  const baseDir=dirname(model3);
  let declared: string[]=[]; try{ const mj=JSON.parse(stripBom(readFileSync(model3,"utf8"))); const ex=mj?.FileReferences?.Expressions; if(Array.isArray(ex)) declared=ex.map((e:any)=>e&&e.File).filter(Boolean); }catch{}
  const declaredSet=new Set(declared.map(f=>String(f).split(sep).join("/")));
  const found:any[]=[];
  (function walk(d:string,depth:number){ if(depth>6) return; let entries:any[]=[]; try{ entries=readdirSync(d,{withFileTypes:true}); }catch{ return;} for(const e of entries){ const full=join(d,e.name); if(e.isDirectory()){ walk(full,depth+1); continue;} if(!e.name.toLowerCase().endsWith(".exp3.json")) continue; const rel=relative(baseDir,full).split(sep).join("/"); if(rel.startsWith("..")) continue; // params = Id yang ditulis file ekspresi (data rigger, bukan tebakan) —
  // dipakai client untuk gate overlay-vs-native (dobel-gambar rig v5). File
  // rusak → params kosong, bukan error: discovery tidak boleh gagal total.
  let params:string[]=[]; try{ const j=JSON.parse(stripBom(readFileSync(full,"utf8"))); if(Array.isArray(j?.Parameters)) params=j.Parameters.map((p:any)=>p&&typeof p.Id==="string"?p.Id:null).filter(Boolean).slice(0,64); }catch{}
  params=[...new Set(params)];
  found.push({ Name:e.name.replace(/\.exp3\.json$/i,""), File:rel, declared:declaredSet.has(rel), params }); } })(dir,0);
  found.sort((a,b)=>a.Name.localeCompare(b.Name));
  return { model3: relative(DATA,model3).split(sep).join("/"), declaredCount:declaredSet.size, expressions:found, orphanCount:found.filter(f=>!f.declared).length };
}
function sanitizeKey(name:string){ return (name||"default").replace(/[^A-Za-z0-9_\u4e00-\u9fff]/g,"_"); }
function sheetPathFor(name:string){ return join(SHEETS_DIR, sanitizeKey(name)+".json"); }

// ── MOTION helpers ──────────────────────────────────────────────
// `ensure` hanya di jalur tulis: GET motions TIDAK boleh men-create direktori
// kosong sebagai side effect (v1 semantics — read path read-only).
function motionsDirFor(modelKey:string, ensure=false){
  const dir=join(MOTIONS_DIR, sanitizeKey(modelKey));
  if(!dir.startsWith(MOTIONS_DIR)) throw new Error("model key tidak valid");
  if(ensure) mkdirSync(dir,{recursive:true});
  return dir;
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
    const cfg=config.load(); const conns=cfg.connections.map(c=>{ const o={...c} as any; if(o.apiKey && !o.apiKey.startsWith("MASUKKAN")) o.apiKey=config.maskKey(o.apiKey); o.roles=normalizeRoles(o.roles);   // selalu array — UI tak perlu cek undefined
    return o; });
    return json({ activeId:cfg.activeId, connections:conns, tts:cfg.tts||{}, events:cfg.events||{}, camera:cfg.camera||{}, motion:cfg.motion||{}, stt:cfg.stt||{}, overlay:cfg.overlay||{} });
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
    if(action==="add"){ const id="conn_"+Date.now().toString(36); const conn=Object.assign({id,testStatus:"idle",provider:"openai-compatible"} as any, body.connection||{}); conn.id=id; // roles wajib dinormalisasi di server: UI bisa dilewati (curl, config.json diedit tangan), dan role palsu tidak boleh tersimpan.
    conn.roles=normalizeRoles(conn.roles); conns.push(conn); if(!cfg.activeId) cfg.activeId=id; }
    else if(action==="update"){ const i=conns.findIndex(c=>c.id===body.id); if(i<0) return json({error:"connection tidak ada"},404); const upd=body.connection||{}; if(!upd.apiKey||!String(upd.apiKey).trim()) upd.apiKey=conns[i].apiKey; // Bedakan "tidak mengirim roles" (pertahankan yang lama) dari "mengirim array kosong" (user sengaja mengosongkan = wildcard).
    if(Object.prototype.hasOwnProperty.call(upd,"roles")) upd.roles=normalizeRoles(upd.roles); conns[i]=Object.assign({},conns[i],upd); conns[i].id=body.id; }
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
    const {reply,used}=await llmForRole("chat",()=>config.connections,()=>config.activeConnection,(conns)=>config.saveConnections(conns, config.load().activeId), messages, clientSystem);
    return json({reply,used});
  }catch(e:any){ return json({error:e.message}, e.httpStatus||502); }
}

async function handleTestConnection(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"body JSON rusak"},400);
  // PENTING: config.connections mem-parse ulang file SETIAP akses — pegang
  // SATU referensi array, mutasi elemennya, lalu tulis array yang sama.
  // Memanggil getter dua kali = dua parse berbeda dan mutasi hilang.
  const connsNow=config.connections;
  const conn=body.connection||{}; const stored=connsNow.find(x=>x.id===conn.id); if(stored?.apiKey) conn.apiKey=stored.apiKey;
  if((conn.provider||"openai-compatible").toLowerCase()!=="mock" && (!conn.apiKey|| conn.apiKey.startsWith("MASUKKAN"))) return json({valid:false, error:"apiKey belum diisi"},400);
  // Hasil Test WAJIB menulis status ke koneksi tersimpan — kalau tidak, badge
  // di panel tidak pernah berubah walau test berhasil (status hanya ditulis
  // oleh trafik sungguhan lewat llmWithFallback). Test gagal TIDAK menyetel
  // cooldown: itu hak classifier trafik nyata, bukan tombol manual user.
  try{
    const reply=await callLLM(conn,[{role:"user",content:"Reply with just: OK"}]);
    if(stored){ stored.testStatus="success"; stored.lastError=""; config.saveConnections(connsNow, config.load().activeId); }
    return json({valid:true, reply:reply.slice(0,80)});
  }catch(e:any){
    if(stored){ stored.testStatus="error"; stored.lastError=e.message; config.saveConnections(connsNow, config.load().activeId); }
    return json({valid:false, error:e.message});
  }
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

TUGAS: Analisis setiap parameter di atas (berdasarkan nama ID, range, naming convention JP/CN/EN, dan fungsinya di Live2D).
Tentukan:
- id: ID parameter yang bersangkutan
- role: salah satu nama role di atas, atau null jika ini aksesoris/parts kustom/fisika
- group: "Sudut (Angle)", "Mata (Eye)", "Alis (Eyebrow)", "Mulut (Mouth)", "Badan (Body)", "Rambut (Hair)", "Aksesoris (Accessory)", "Physics", atau "Kustom"
- label: nama ringkas yang mudah dipahami manusia (misal "Kedip Mata Kiri", "Pipi Merah")
- isAccessory: boolean true jika ini toggle aksesoris/properti (0/1)

KEMBALIKAN HANYA JSON array valid tanpa markdown formatting tambahan atau pembuka/penutup kata.
Format:
[
  { "id": "ParamX", "role": "angleX", "group": "Sudut (Angle)", "label": "Kepala X", "isAccessory": false }
]`;
  try{
    const {reply}=await llmForRole("sheet", ()=>config.connections,()=>config.activeConnection,(c)=>config.saveConnections(c,config.load().activeId), [{role:"user",content:prompt}]);
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
  const paramLines=params.map((p:any)=>{ const label= typeof p.label==="string"&&p.label.trim()? ` (${p.label.trim().slice(0,40)})`:""; const group= typeof p.group==="string"&&p.group.trim()? ` [grup: ${p.group.trim().slice(0,40)}]`:""; let line=`- "${p.id}"${label}${group} range [${Number(p.min)}, ${Number(p.max)}] default ${Number(p.def)}`; const pn=noteOf(p.id); if(pn) line+=` | penjelasan user: ${pn}`; return line; }).join("\n");
  const prompt=`Kamu pakar rigging Live2D Cubism. Berdasarkan daftar parameter model di bawah, usulkan preset pose yang masuk akal dan SEBANYAK MUNGKIN VARIASI untuk model INI.

PARAMETER TERSEDIA (hanya id di bawah yang boleh dipakai):
${paramLines}

${parts.length? `PART TERSEDIA (opacity 0..1):\n${parts.map((p:string)=>`- "${p}"`).join("\n")}`:"(model ini tidak punya part yang bisa di-toggle — semua efek \"aksesoris\"/\"properti\" harus dibuat lewat kombinasi PARAMETER di atas, misalnya ParamEX01-12, ParamCollarChange, ParamCheekPuff*, ParamtongueOut, dsb, bukan lewat part.)"}

PRESET YANG SUDAH ADA DI PROJECT INI (jangan diusulkan ulang — cek nama & isinya, bukan sekadar nama umum):
${existing.length? existing.join(", "):"(belum ada, kamu bebas berkreasi dari nol)"}

TUGAS: usulkan MINIMAL 12 preset yang BERAGAM, dan pastikan secara KESELURUHAN preset yang kamu usulkan menyentuh SEBANYAK MUNGKIN grup parameter yang tersedia di model ini (mata, alis, mulut, pipi, bola mata, sudut kepala/badan, custom EX, collar, breath, dll) — jangan cuma berputar di ParamMouthForm & ParamEyeLSmile terus-menerus.

Untuk tiap preset tentukan:
- name: nama singkat bahasa Indonesia (maks 60 karakter), unik, tidak boleh sama/mirip dengan preset yang sudah ada maupun sesama preset baru
- category: salah satu dari ${CATS.join(" / ")}
  · emosi     = ekspresi wajah (mata, alis, mulut, pipi, bola mata)
  · properti  = perubahan tampilan non-aksesoris (warna pipi, ganti kerah, bentuk custom lain)
  · aksesoris = toggle benda yang dipakai/dilepas (via part jika ada, atau via parameter EX/kustom yang berfungsi sebagai toggle)
- values: objek { "ParamId": angka } berisi HANYA id dari daftar di atas
- parts: objek { "PartId": angka 0..1 }, boleh kosong jika model tidak punya part

ATURAN KERAS:
1. JANGAN mengarang id parameter atau part yang tidak ada di daftar.
2. JANGAN menyertakan min, max, def, atau steps. Itu bukan tugasmu.
3. Sertakan hanya parameter yang benar-benar berubah dari default (3-8 per preset).
4. Kategori "gerak" TIDAK BOLEH diusulkan.
5. WAJIB BERAGAM:
   - MINIMAL 6 preset kategori "emosi" dengan nama & kombinasi parameter yang benar-benar berbeda satu sama lain (contoh arah: senang, sedih, kaget, malu, marah/kesal, bingung, mengantuk, jijik, takut, bangga — pilih & sesuaikan dengan parameter yang tersedia, JANGAN ulang preset yang sudah ada di daftar existing).
   - Sisanya campuran "properti" dan "aksesoris" yang memanfaatkan parameter non-wajah/non-emosi seperti ParamEX01-12, ParamCollarChange, ParamCheekPuff*, ParamtongueOut, ParamBreath, atau part (jika tersedia).
   - Usahakan setiap preset punya kombinasi parameter yang unik — hindari 2 preset dengan isi "values" yang nyaris identik.
   - Jika model punya banyak parameter custom/EX yang belum kepakai sama sekali di preset manapun, prioritaskan membuat preset baru yang memakainya, selama hasilnya tetap masuk akal secara visual.

KEMBALIKAN HANYA JSON array valid, tanpa markdown atau kata pembuka/penutup.
Format (Note: INI Contoh STRUKTUR, bukan daftar yang wajib diikuti — ganti dengan emosi & parameter milik model ini):
[
  { "name": "Senang", "category": "emosi", "values": { "ParamMouthForm": 1 }, "parts": {} },
  { "name": "Sedih", "category": "emosi", "values": { "ParamMouthForm": -1, "ParamEyeLSmile": -1 }, "parts": {} },
  { "name": "Kacamata", "category": "aksesoris", "values": {}, "parts": { "PartGlasses": 1 } }
]`;
  try{
    const {reply}=await llmForRole("sheet", ()=>config.connections,()=>config.activeConnection,(c)=>config.saveConnections(c,config.load().activeId), [{role:"user",content:prompt}]);
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
      if(it.values&&typeof it.values==="object"&&!Array.isArray(it.values)){ for(const k of Object.keys(it.values)){ const r=ranges.get(k) as {lo:number;hi:number}|undefined; const n=Number((it.values as any)[k]); if(!r||!Number.isFinite(n)) continue; values[k]=Math.max(r.lo, Math.min(r.hi,n)); } }
      const pparts:Record<string,number>={};
      if(it.parts&&typeof it.parts==="object"&&!Array.isArray(it.parts)){ for(const k of Object.keys(it.parts)){ const n=Number((it.parts as any)[k]); if(!partIds.has(k)||!Number.isFinite(n)) continue; pparts[k]=Math.max(0,Math.min(1,n)); } }
      if(!Object.keys(values).length && !Object.keys(pparts).length){dropped++;return acc;}
      seen.add(key); acc.push({name,category,values,parts:pparts,source:"ai"}); return acc;
    },[]).slice(0,12);
    if(dropped) console.warn("[analyze-sheet] dropped",dropped);
    return json({presets:safe});
  }catch(e:any){ console.warn("[analyze-sheet]",e.message); return json({presets:[], warning:e.message}); }
}

// Susun blok "PENJELASAN PARAMETER DARI USER" untuk director prompt dari
// object paramNotes mentah (id -> teks user). Batas keras 24 entri × 200
// karakter — memindahkan blok tak terbatas dari prompt teks ke prompt motion
// hanya memindahkan masalahnya, bukan menyelesaikannya. "" bila tak ada yang layak.
export function formatParamNotes(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const entries = Object.entries(raw as Record<string, unknown>).slice(0, 24);
  const lines: string[] = [];
  for (const [id, val] of entries) {
    if (typeof id !== "string" || !id || typeof val !== "string") continue;
    const clean = val.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, 200);
    if (clean) lines.push("- \"" + id.slice(0, 60) + "\": " + clean);
  }
  return lines.join("\n");
}

/** Bersihkan teks persona/nama dari body client (jalur /api/animate-text):
 *  buang control char — newline & tab DIPERTAHANKAN (persona boleh
 *  multi-baris, paritas sanitizeUserNote di app.js) — trim, batasi panjang.
 *  "" bila bukan string atau kosong. */
export function sanitizePersonaText(raw: unknown, cap = 800): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, cap);
}

async function handleAnimateText(req:Request):Promise<Response>{
  const body=await readBody(req); if(!body) return json({error:"body JSON rusak"},400);
  const text=(body.text||"").trim(); const caps=body.capabilities||{};
  const emotions=(caps.emotions&&caps.emotions.length)?caps.emotions:["senang","sedih","malu","kaget","normal"];
  const gestures=(caps.gestures&&caps.gestures.length)?caps.gestures:["nod","shake","tilt_curious","lean_excited","recoil_surprised","look_away_shy","laugh_bounce","think","wave_hi"];
  const motions=Array.isArray(caps.motions)? caps.motions.filter((m:any)=>m&&m.id):[];
  // Penjelasan parameter tulisan USER (dari character sheet, dikirim brain).
  // Otoritatif: director harus menghormati makna ini, bukan menebak dari nama id.
  const noteLines=formatParamNotes(body.paramNotes);
  // Identitas karakter (nama + persona) dari brain — opsional, "" bila user
  // belum menulisnya. Director memakainya agar emosi/gesture konsisten dengan
  // kepribadian karakter, bukan gaya generik.
  const personaLines=sanitizePersonaText(body.persona);
  const charName=sanitizePersonaText(body.characterName,60);
  if(!text) return json({segments:[]});
  if(!config.activeConnection) return json({segments:[{text,emotion:"normal",gesture:"nod",intensity:0.7}]});
  const directorPrompt=`Kamu adalah animation director untuk karakter Live2D Anime yang hidup dan ekspresif.
Karakter baru saja berbicara teks berikut:
"${text}"
${charName ? "\nKarakter yang kamu animasikan: " + charName + "\n" : ""}
Daftar Emosi yang didukung model: [${emotions.join(", ")}]
Daftar Gesture yang tersedia: [${gestures.join(", ")}]
${motions.length? "Gerakan buatan user (Motion Studio) — pakai field \"motion\" dengan id PERSIS:\n"+motions.slice(0,24).map((m:any)=>"- "+m.id+": "+(m.description||m.id)+(m.compatibleEmotions&&m.compatibleEmotions.length? " (cocok saat: "+m.compatibleEmotions.join(", ")+")":"")).join("\n")+"\nGerakan ini dirancang user sendiri; utamakan bila maknanya pas. Jangan mengarang id.\n":""}
${noteLines ? "\nPENJELASAN PARAMETER DARI USER (otoritatif — hormati makna ini):\n"+noteLines+"\n" : ""}
${personaLines ? "\nKEPRIBADIAN KARAKTER (ditulis user — pilih emosi, gesture, dan intensity yang konsisten dengan kepribadian ini, jangan generik):\n"+personaLines+"\n" : ""}
TUGAS:
1. Pecah teks di atas menjadi beberapa segment (per klausa atau per kalimat) agar karakter bergerak seirama omongannya secara hidup (jangan diam selama bicara!).
2. Sebelum menentukan emotion/gesture, analisis dulu makna & nada tiap segment secara independen — apa yang sedang dirasakan/disampaikan karakter DI SEGMENT ITU, bukan di segment lain.
3. Untuk setiap segment, tentukan:
   - "text": teks klausa/kalimat tersebut (harus sama persis dengan teks asli bila digabung kembali)
   - "emotion": emosi yang SANGAT SESUAI dengan makna klausa tersebut (dari daftar emosi di atas). Emosi WAJIB berubah mengikuti pergeseran nada teks — jangan pakai emosi yang sama untuk semua segment kecuali teksnya memang konsisten satu nada dari awal sampai akhir.
   - "gesture": nama gesture yang pas (atau null jika netral)${motions.length? '\n   - "motion": id gerakan user bila ada yang sangat pas (atau null)':""}
   - "intensity": angka 0.3 s/d 1.0 (seberapa kuat ekspresinya, 0.4=halus, 0.8=ekspresif) — sesuaikan naik-turun sesuai kekuatan emosi tiap segment, jangan pakai angka yang sama terus-menerus.

ATURAN PENTING:
- Nilai emotion/gesture/motion/intensity HARUS berdasarkan analisis makna teks asli di atas, BUKAN meniru contoh format di bawah. Contoh di bawah HANYA untuk menunjukkan struktur/skema JSON yang benar, isinya tidak relevan dengan teks yang sedang kamu proses sekarang.
- Jangan mengarang nama emotion/gesture di luar daftar yang diberikan.
- Jika teks berisi banyak pergeseran emosi (mis. dari senang ke sedih ke marah), pastikan output JSON merefleksikan pergeseran itu per segment.

KEMBALIKAN HANYA JSON array valid tanpa markdown formatting atau kata pengantar.

Skema (bukan contoh isi — hanya struktur):
[
  { "text": "<klausa 1>", "emotion": "<pilih dari daftar emosi sesuai makna klausa 1>", "gesture": "<pilih dari daftar gesture atau null>", "intensity": <0.3-1.0> },
  { "text": "<klausa 2>", "emotion": "<pilih dari daftar emosi sesuai makna klausa 2>", "gesture": "<pilih dari daftar gesture atau null>", "intensity": <0.3-1.0> }
]`;
  try{
    const {reply}=await llmForRole("motion", ()=>config.connections,()=>config.activeConnection,(c)=>config.saveConnections(c,config.load().activeId), [{role:"user",content:directorPrompt}]);
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
Data gerakan (peran semantik, bukan parameter mentah):
durasi: ${Number(m.duration)||1} detik
${tracks.map((t:any)=>`- ${t.target}: rentang ${t.range[0]}..${t.range[1]}, ${t.keyframes} keyframe`).join("\n")}

Nama track bisa berupa nama peran singkat atau nama parameter rig:
ax=kepala kiri/kanan, ay=kepala atas/bawah, bodyZ=badan miring,
bodyX/bodyY=badan geser, ex/ey=arah bola mata, mouthForm=bentuk mulut.
Nama lain (mis. ParamHairFront, ParamArmLA, "Alis Kiri") adalah parameter rig —
tebak maknanya dari namanya sendiri. Rentang nilai tiap track sudah diberikan
di atas; satuannya berbeda-beda per parameter, jadi baca rentangnya, jangan
mengasumsikan derajat.

TUGAS: tebak gerakan ini sedang menyampaikan apa, lalu balas JSON:
{
  "description": "satu kalimat bahasa Indonesia, deskriptif, maksimal 120 karakter",
  "tags": ["3-5 tag bahasa Indonesia satu kata"],
  "emotionCompatibility": { "<emosi>": 0.0-1.0 }
}
Emosi yang boleh dipakai HANYA: [${emotions.join(", ")}]
KEMBALIKAN HANYA JSON, tanpa markdown atau kata pengantar.`;
  try{
    const {reply}=await llmForRole("motion", ()=>config.connections,()=>config.activeConnection,(c)=>config.saveConnections(c,config.load().activeId), [{role:"user",content:prompt}]);
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

Kamu HANYA boleh memakai nama track berikut. Ini nama PERAN, bukan nama parameter
model — klien yang akan menerjemahkannya ke parameter rig yang sesuai:
ax    = kepala kiri(-)/kanan(+), derajat, batas ±30
ay    = kepala atas(-)/bawah(+), derajat, batas ±30
bodyZ = badan miring, derajat, batas ±30
bodyX = badan geser kiri/kanan, derajat, batas ±30
bodyY = badan naik/turun, derajat, batas ±30
ex    = bola mata kiri(-)/kanan(+), −1..1
ey    = bola mata atas(-)/bawah(+), −1..1
mouthForm = bentuk mulut, −1..1

JANGAN menyebut nama parameter model seperti ParamAngleX atau ParamHairFront —
kamu tidak tahu nama parameter rig ini dan menebaknya akan ditolak.

Aturan:
- Maksimal 4 track, maksimal 6 keyframe per track.
- t dalam detik, mulai 0, tidak melebihi durasi.
- Durasi 0.6 sampai 3 detik.
- Gerakan yang bagus PULANG ke 0 di keyframe terakhir supaya tidak nyangkut.
- Nilai realistis: ±5..15 derajat untuk kepala, ±0.2..0.6 untuk mata.

Balas JSON persis format ini:
{
  "id": "nama_id_snake_case",
  "name": "Nama Singkat",
  "description": "satu kalimat bahasa Indonesia",
  "tags": ["dua-empat tag"],
  "duration": 1.4,
  "emotionCompatibility": { "<emosi>": 0.0-1.0 },
  "tracks": [
    { "target": "ay", "keys": [{ "t": 0, "v": 0 }, { "t": 0.4, "v": 8 }, { "t": 1.4, "v": 0 }] }
  ]
}
Emosi yang boleh dipakai HANYA: [${emotions.join(", ")}]
KEMBALIKAN HANYA JSON, tanpa markdown atau kata pengantar.`;
  try{
    const {reply}=await llmForRole("motion", ()=>config.connections,()=>config.activeConnection,(c)=>config.saveConnections(c,config.load().activeId), [{role:"user",content:prompt}]);
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
    const folders=readdirSync(MODEL_DIR,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name);
    // Auto-Rescue: folder tanpa manifest yang punya .moc3 ikut terdaftar —
    // manifest virtualnya disajikan route /model/<folder>/__rescue__.model3.json.
    const usable: string[]=[];
    for(const name of folders){ const dir=join(MODEL_DIR,name); try{ if(findModel3(dir)||buildRescueBlueprint(dir)) usable.push(name); }catch{} }
    return json({models:usable.sort()});
  }catch(e:any){ return json({error:e.message},500); }
}
function handleModelPath(req:Request):Response{
  try{
    const name=new URL(req.url).searchParams.get("name"); const dir=join(MODEL_DIR,name||"");
    if(!dir.startsWith(MODEL_DIR)||!existsSync(dir)) throw new Error("not found");
        let abs=findModel3(dir);
    // Auto-Rescue: folder tanpa manifest → sajikan blueprint virtual.
    if(!abs){ const bp=buildRescueBlueprint(dir); if(!bp) throw new Error("no model3.json in folder");
      return json({ path: "model/"+(name||"")+"/"+RESCUE_FILENAME, rescued: true }); }
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
    // taxonomy is a v2-owned module imported at the top of this file
    const taxo:any = MotionTaxonomy;
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
    const asset=(sanitized as any).asset; motionsDirFor(modelKey,true); const file=motionFileFor(modelKey,asset.id);
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
    const asset=(sanitized as any).asset; motionsDirFor(modelKey,true); const file=motionFileFor(modelKey,id);
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

// ── start server (only when run directly, not when imported for type-check) ─
export { handleAPI, serveStatic, config };
let server: ReturnType<typeof Bun.serve> | null = null;
if (import.meta.main) {
server = Bun.serve({
  port: PORT,
  // Default bind loopback seperti v1: server ini memegang apiKey plaintext di
  // config — tidak boleh telanjang ke LAN. Set HOST=0.0.0.0 bila memang mau
  // diakses dari jaringan (frontend pakai location.origin, jadi tetap jalan).
  hostname: process.env.HOST || "127.0.0.1",
  async fetch(req){
    if(req.method==="OPTIONS") return cors(new Response(null,{status:204}));
    const url=new URL(req.url); let pathname=url.pathname;
    // api first
    try{
      const apiResp=await handleAPI(req);
      if(apiResp) return apiResp;
    }catch(e:any){
      if(e instanceof BodyTooLargeError) return json({error:e.message},413);
      throw e;
    }
    // Unknown /api/* → 404 JSON, BUKAN SPA fallback (v1 semantics)
    if(pathname.startsWith("/api/")) return json({error:"not found"},404);
    if(pathname==="/") pathname="/index.html";
    // Auto-Rescue: manifest virtual model/<folder>/__rescue__.model3.json —
    // dirakit di memori untuk folder yang tidak punya .model3.json sungguhan.
    {
      const m=decodeURIComponent(pathname).match(/^\/model\/([^/]+)\/__rescue__\.model3\.json$/i);
      if(m){
        const dir=join(MODEL_DIR,m[1]);
        if(!dir.startsWith(MODEL_DIR)) return new Response("Forbidden",{status:403});
        const bp=buildRescueBlueprint(dir);
        if(!bp) return json({error:"folder ini tidak bisa dirakit (tidak ada .moc3, atau manifest sudah ada)"},404);
        return json(bp.manifest);
      }
    }
    const staticResp=serveStatic(pathname);
    if(staticResp) return staticResp;
    // SPA fallback HANYA untuk path tanpa ekstensi (rute UI). Asset JS/CSS/
    // model yang salah ketik/missing harus 404 yang jelas — bukan index.html
    // 200 yang membuat browser mengunduh HTML dengan tipe .js (error MIME samar).
    const lastSeg=pathname.split("/").pop()||"";
    if(lastSeg && !lastSeg.includes(".")){
      const fallback=serveStatic("/index.html");
      if(fallback) return fallback;
    }
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
