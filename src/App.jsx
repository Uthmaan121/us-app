
import React, { useState, useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/* ════════════════════════════════════════════
   CONFIG  — fill in your Firebase detailss
════════════════════════════════════════════ */
const NFC_TOKEN     = "8f4a2b7c1d3e9f5a6b8c0d4e1f2a3b5c"; // ← write this onto your NFC tag
const ALLOWED_EMAILS= ["hyphen080@gmail.com","malikareebah157@gmail.com"];
// Each account is permanently tied to one identity — "me" vs "them" is derived
// from which email is signed in, never a per-device default both users share.
const ROLE_BY_EMAIL = {"hyphen080@gmail.com":"uthmaan","malikareebah157@gmail.com":"areebah"};
const ROLE_NAMES    = {uthmaan:"Uthmaan",areebah:"Areebah"};
// Fixed per-account accent colours, used anywhere authorship needs to be
// told apart at a glance (fridge notes, chat bubbles, etc.) — independent
// of the active colour theme so it's always readable either way.
const ROLE_COLORS   = {uthmaan:"#3D6FD6",areebah:"#D6407D"};
const otherRole = r => r==="uthmaan"?"areebah":"uthmaan";
const MAX_USERS     = 5;
const DEF_START     = "2026-04-14";

// ← paste your Firebase Web API key & DB URL in Settings, or hardcode here:
let FIREBASE_API_KEY = "AIzaSyAc1LN7uRNdrSkejFXdjh8CiCQJPCIYU1A";
let FIREBASE_DB_URL  = "https://ustag-22e9c-default-rtdb.firebaseio.com";

/* ── Firebase Auth REST ─────────────────────────────────── */
const authUrl = endpoint =>
  `https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${FIREBASE_API_KEY}`;

async function fbSignIn(email, password){
  const r = await fetch(authUrl("signInWithPassword"),{
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({email,password,returnSecureToken:true})
  });
  const d = await r.json();
  if(d.error) throw new Error(prettifyAuthErr(d.error.message));
  return d;
}
async function fbSignUp(email, password){
  if(!ALLOWED_EMAILS.includes(email.toLowerCase()))
    throw new Error("This email is not authorised to access us.");
  const r = await fetch(authUrl("signUp"),{
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({email,password,returnSecureToken:true})
  });
  const d = await r.json();
  if(d.error){
    if(d.error.message==="EMAIL_EXISTS") throw new Error("This email is already registered — tap \"Already registered? Sign in\" below.");
    throw new Error(prettifyAuthErr(d.error.message));
  }
  return d;
}
async function fbResetPassword(email){
  const r=await fetch(authUrl("sendOobCode"),{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({requestType:"PASSWORD_RESET",email})
  });
  const d=await r.json();
  if(d.error)throw new Error(prettifyAuthErr(d.error.message));
  return true;
}
function prettifyAuthErr(msg){
  const map={
    EMAIL_NOT_FOUND:"No account found with that email.",
    INVALID_PASSWORD:"Incorrect password.",
    TOO_MANY_ATTEMPTS_TRY_LATER:"Too many attempts. Try again later.",
    WEAK_PASSWORD:"Password must be at least 6 characters.",
    INVALID_EMAIL:"Invalid email address.",
    USER_NOT_FOUND:"No account found with that email.",
  };
  return map[msg]||msg;
}

/* ── Firebase session (ID token, kept fresh for DB auth) ──── */
let FIREBASE_ID_TOKEN = null;

function persistAuthSession(d){
  FIREBASE_ID_TOKEN = d.idToken;
  ss("auth_user", { email: d.email, idToken: d.idToken, refreshToken: d.refreshToken, ts: Date.now() });
}

async function refreshFirebaseToken(){
  const auth = gs("auth_user", null);
  if(!auth || !auth.refreshToken) return null;
  try{
    const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(auth.refreshToken)}`,
    });
    const d = await r.json();
    if(d.error) return null;
    FIREBASE_ID_TOKEN = d.id_token;
    ss("auth_user", { email: auth.email, idToken: d.id_token, refreshToken: d.refresh_token, ts: Date.now() });
    return d.id_token;
  }catch{ return null; }
}

/* ── Firebase Realtime DB REST ──────────────────────────── */
const dbPath = p => `${FIREBASE_DB_URL}/${p}.json${FIREBASE_ID_TOKEN?`?auth=${encodeURIComponent(FIREBASE_ID_TOKEN)}`:""}`;
async function dbWrite(path,data){ if(!FIREBASE_DB_URL)return; await fetch(dbPath(path),{method:"PUT",body:JSON.stringify(data),headers:{"Content-Type":"application/json"}}); }
async function dbGet(path){ if(!FIREBASE_DB_URL)return null; try{const r=await fetch(dbPath(path));const d=await r.json();return d;}catch{return null;} }
function dbListen(path,cb){
  if(!FIREBASE_DB_URL)return()=>{};
  try{
    const es=new EventSource(dbPath(path));
    es.addEventListener("put",e=>{ try{const d=JSON.parse(e.data);if(d&&d.data!==null)cb(d.data);}catch{} });
    es.addEventListener("error",()=>{});
    return()=>es.close();
  }catch{return()=>{};}
}

/* ── NFC helpers — no persistence, clears on every refresh ── */
// nfcOk lives only in React state. Closing/refreshing always requires re-scan.
function nfcValidateToken(token){ return token===NFC_TOKEN; }
function nfcTouch(){} // no-op — intentional

/* ── Shared-state hook ──────────────────────────────────── */
const gs=(k,fb)=>{try{const v=localStorage.getItem(k);return v!=null?JSON.parse(v):fb;}catch{return fb;}};
const ss=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));}catch{}};
function useSync(key,def){
  const [val,setVal]=useState(()=>gs("sync_"+key,def));
  useEffect(()=>{ const u=dbListen("room/"+key,v=>{setVal(v);ss("sync_"+key,v);});return u;},[key]);
  const update=useCallback(v=>{setVal(v);ss("sync_"+key,v);dbWrite("room/"+key,v);},[key]);
  return[val,update];
}

/* ── Utils ──────────────────────────────────────────────── */
function hav(la1,lo1,la2,lo2){
  const R=6371,d=Math.PI/180,dlat=(la2-la1)*d,dlon=(lo2-lo1)*d;
  const a=Math.sin(dlat/2)**2+Math.cos(la1*d)*Math.cos(la2*d)*Math.sin(dlon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
const fmtDist=km=>{const mi=km*0.621371;return mi<0.1?`${Math.round(mi*5280)} ft`:`${mi.toFixed(1)} mi`;};
function calcE(s){
  let d=Math.max(0,Math.floor((Date.now()-new Date(s))/1000));
  const yr=Math.floor(d/31557600);d-=yr*31557600;const mo=Math.floor(d/2629800);d-=mo*2629800;
  const dy=Math.floor(d/86400);d-=dy*86400;const hr=Math.floor(d/3600);d-=hr*3600;
  const mn=Math.floor(d/60);const sc=d%60;return{yr,mo,dy,hr,mn,sc};
}
const pad=n=>String(n).padStart(2,"0");
const ago=ts=>{if(!ts)return null;const s=Math.floor((Date.now()-ts)/1000);if(s<60)return"just now";if(s<3600)return`${Math.floor(s/60)}m ago`;if(s<86400)return`${Math.floor(s/3600)}h ago`;return`${Math.floor(s/86400)}d ago`;};
const fmtD=ts=>new Date(ts).toLocaleDateString("en-GB",{day:"numeric",month:"short"});
const fmtDL=ts=>new Date(ts).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"long"});
const fmtFull=ts=>new Date(ts).toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"});

async function compressImg(file,maxPx=1080,q=0.65){
  return new Promise(resolve=>{
    const img=new Image();const url=URL.createObjectURL(file);
    img.onload=()=>{
      URL.revokeObjectURL(url);
      const sc=Math.min(1,maxPx/Math.max(img.width,img.height));
      const w=Math.round(img.width*sc),h=Math.round(img.height*sc);
      const cv=document.createElement("canvas");cv.width=w;cv.height=h;
      cv.getContext("2d").drawImage(img,0,0,w,h);
      resolve(cv.toDataURL("image/jpeg",q));
    };
    img.onerror=()=>resolve(null);img.src=url;
  });
}

/* ── Free place research (OpenStreetMap — no API key, no cost) ─ */
async function researchPlaces(dateType,location){
  const resp=await fetch("/.netlify/functions/places",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({dateType,location})
  });
  const data=await resp.json().catch(()=>({}));
  if(!resp.ok||data.error)throw new Error(data.error||"Server error "+resp.status+".");
  return Array.isArray(data.results)?data.results:[];
}

/* ── Defaults ───────────────────────────────────────────── */
const DEF_NAMES={home:"Uss",me:"Me",fridge:"Fridge",dates:"Dates",map:"Map",gallery:"Gallery",notes:"Notes",settings:"Settings"};
const DEF_CATS=[{id:"together",label:"💑 Together"},{id:"solo_me",label:"🙋 Solo Me"},{id:"solo_them",label:"💁 Solo Them"},{id:"places",label:"🏔️ Places"},{id:"faves",label:"⭐ Favourites"}];
const DEF_MOODS=["😍","🥰","😊","😌","🤩","😴","😢","🔥"];
const NOTE_COLS=["#FDDCD4","#FDDDF0","#D4DDFD","#D4FDD8","#FDFAD4","#EDD4FD"];
const IDEAS_DEF=[
  {id:1,e:"🎬",n:"Movie Night",cat:"indoor"},{id:2,e:"🍽️",n:"Fancy Dinner",cat:"food"},
  {id:3,e:"🌅",n:"Sunrise Walk",cat:"outdoor"},{id:4,e:"🎡",n:"Theme Park",cat:"outdoor"},
  {id:5,e:"🧁",n:"Bake Together",cat:"indoor"},{id:6,e:"🏖️",n:"Beach Day",cat:"outdoor"},
  {id:7,e:"🎮",n:"Gaming",cat:"indoor"},{id:8,e:"🌿",n:"Picnic",cat:"outdoor"},
  {id:9,e:"🎨",n:"Paint Date",cat:"indoor"},{id:10,e:"⭐",n:"Stargazing",cat:"outdoor"},
  {id:11,e:"💆",n:"Spa Day",cat:"wellness"},{id:12,e:"🚗",n:"Road Trip",cat:"outdoor"},
  {id:13,e:"🎳",n:"Bowling",cat:"indoor"},{id:14,e:"🍦",n:"Dessert Run",cat:"food"},
  {id:15,e:"🎭",n:"Theatre / Show",cat:"culture"},{id:16,e:"🏊",n:"Swimming",cat:"wellness"},
];
const THEMES={
  blush:{name:"Blush",bg:"#FCF0EC",sf:"#fff",rose:"#F3DDD5",deep:"#EDD0C4",accent:"#C45450",ink:"#1A1512"},
  midnight:{name:"Midnight",bg:"#0F0F14",sf:"#1A1A24",rose:"#2A1F2E",deep:"#1E1528",accent:"#B06FD8",ink:"#F0EAF5"},
  forest:{name:"Forest",bg:"#F0F4F0",sf:"#fff",rose:"#D5E8D5",deep:"#C4DCCA",accent:"#3D7A54",ink:"#1A2A1F"},
  ocean:{name:"Ocean",bg:"#EFF5FB",sf:"#fff",rose:"#D4E6F5",deep:"#C4D8F0",accent:"#2A72B5",ink:"#0F1F30"},
  sand:{name:"Sand",bg:"#FAF5ED",sf:"#fff",rose:"#EDE0CF",deep:"#E0D0B8",accent:"#A07840",ink:"#2A1F10"},
  // Opt-in preview only — never the default. Selecting it doesn't change any
  // of the five themes above; it's purely an extra option to try.
  claudetest:{name:"Claude Theme Test",bg:"#16130F",sf:"#221D18",rose:"#2E2620",deep:"#271F19",accent:"#E67E4D",ink:"#F6EEE6"},
};
const NAV_IDS=["home","me","fridge","dates","map","gallery","notes","settings"];

/* ── Birthdays ─────────────────────────────────────────────────────────── */
const BIRTHDAYS=[
  {name:"Areebah",day:15,month:7,year:2003,emoji:"🌸",
   msg:"Today is Areebah's birthday. Uthmaan built this whole thing for her — today more than ever, he hopes it makes her feel exactly how loved she is. 💕"},
  {name:"Uthmaan",day:14,month:6,year:2005,emoji:"💙",
   msg:"It's Uthmaan's birthday today. He'd probably say something modest, but this app says it all. Show him some love. 🎂"},
];

/* ── App version for intro tracking ───────────────────────────────────── */
const APP_VERSION="2.1";

/* ── Intro slides ─────────────────────────────────────────────────────── */
const INTRO_SLIDES=[
  {emoji:"💕",title:"Hey Areebah.",
   body:"Uthmaan built you something. Not because he had to — because he wanted you to have a place that's entirely yours. Hidden from the world, made for no one but the two of you.",
   sub:"Welcome to us."},
  {emoji:"⏱️",title:"He's been counting.",
   body:"Every second since the day this started. Open the home screen and you'll see it — years, months, days, hours, minutes, and seconds. He built a timer because to him, not one of them goes unnoticed.",
   tag:"Home"},
  {emoji:"💭",title:"When words aren't enough.",
   body:"Leave a mood emoji. Send a quick note. He sees it the moment you do — and when he's thinking of you, you'll see his. No big conversations needed. Just you two, always checking in.",
   tag:"Mood"},
  {emoji:"📋",title:"Little reminders.",
   body:"Uthmaan leaves notes here. Some silly, some serious — all for you. Stick your own up too. Think of it as the fridge door of your relationship. Nothing important ever gets lost.",
   tag:"Fridge"},
  {emoji:"💝",title:"Date night, sorted.",
   body:"Pick an idea, type the area, and the app finds real places nearby. It even checks if they're halal and tells you what it'll cost. Uthmaan thought of the details so neither of you has to.",
   tag:"Dates"},
  {emoji:"🗺️",title:"Every place, remembered.",
   body:"Every restaurant you visit, every walk, every moment in a new city — pin it here. In ten years, you'll open this map and see your whole story written in places.",
   tag:"Map"},
  {emoji:"📸",title:"Private and yours.",
   body:"Photos and videos, locked away in categories. No one else can see them — not even by accident. Your personal album, exactly as private as it should be.",
   tag:"Gallery"},
  {emoji:"🔒",title:"Even from him.",
   body:"The Notes section is completely yours. Uthmaan cannot read them. Not even if he tried. This space is for whatever you feel, whenever you need to write it down. Just you.",
   tag:"Private Notes"},
  {emoji:"🎂",title:"The dates that matter most.",
   body:"Birthdays are tracked and celebrated. On yours, the whole app throws a little party — because Uthmaan built in a reminder to celebrate you every single year.",
   tag:"Birthdays"},
  {emoji:"💕",title:"He made all of this. For you.",
   body:"us. is Uthmaan's way of saying — I love you enough to build you a whole world. Fill it with memories, keep it close, and know that every single feature in here was thought of with you in mind.",
   sub:"This is us."},
];

/* ── CSS ────────────────────────────────────────────────── */
function buildCSS(theme,bgImg){
  const t=THEMES[theme]||THEMES.blush;
  return `
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400&family=Inter:wght@300;400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:${t.bg};--sf:${t.sf};--rose:${t.rose};--deep:${t.deep};--ink:${t.ink};--slate:${t.ink}99;--muted:${t.ink}66;--border:${t.accent}28;--accent:${t.accent};--aclt:${t.accent}88;--sh:0 2px 16px ${t.accent}14;--sh-md:0 6px 32px ${t.accent}22;--r:18px}
html,body,#root{height:100%;background:var(--bg)}
body{font-family:'Inter',-apple-system,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;overscroll-behavior:none}
::-webkit-scrollbar{display:none}*{scrollbar-width:none}input,textarea,button,select{font-family:inherit}
.us-app{display:flex;flex-direction:column;height:100dvh;max-width:480px;margin:0 auto;background:${bgImg?`url(${bgImg}) center/cover no-repeat`:"var(--bg)"};position:relative;overflow:hidden}
.us-hdr{height:52px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;flex-shrink:0;background:${bgImg?"rgba(0,0,0,.15)":"var(--bg)"};backdrop-filter:${bgImg?"blur(10px)":""};-webkit-backdrop-filter:${bgImg?"blur(10px)":""};z-index:10}
.us-page{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:10px 14px calc(env(safe-area-inset-bottom,0px) + 76px)}
.us-nav{height:calc(58px + env(safe-area-inset-bottom,0px));background:${bgImg?"rgba(0,0,0,.25)":"var(--sf)"};backdrop-filter:${bgImg?"blur(14px)":""};-webkit-backdrop-filter:${bgImg?"blur(14px)":""};border-top:1px solid var(--border);display:flex;align-items:center;overflow-x:auto;flex-shrink:0;padding:0 4px calc(env(safe-area-inset-bottom,0px) + 2px)}
.pf{animation:pFade .2s ease}@keyframes pFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.logo{font-family:'Cormorant Garamond',serif;font-size:clamp(22px,6vw,28px);font-weight:600;font-style:italic;color:var(--ink)}
.sec-title{font-family:'Cormorant Garamond',serif;font-size:clamp(18px,5vw,22px);font-weight:600;color:var(--ink);margin-bottom:12px}
.lbl{font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.cap{font-size:12px;color:var(--muted);line-height:1.5}
.card{background:var(--sf);border-radius:var(--r);padding:16px;margin-bottom:10px;box-shadow:var(--sh)}
.card-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.card-title{font-family:'Cormorant Garamond',serif;font-size:clamp(16px,4.5vw,18px);font-weight:600;color:var(--ink)}
.ctr-card{background:linear-gradient(140deg,var(--deep) 0%,var(--rose) 55%,var(--deep) 100%);border-radius:var(--r);padding:clamp(14px,4vw,20px) clamp(12px,4vw,18px);margin-bottom:10px;position:relative;overflow:hidden}
.ctr-card::after{content:'';position:absolute;top:-50px;right:-50px;width:160px;height:160px;background:rgba(255,255,255,.12);border-radius:50%;pointer-events:none}
.ctr-ey{display:flex;align-items:center;gap:7px;margin-bottom:clamp(10px,3vw,14px)}
.ctr-row{display:flex;align-items:flex-end;position:relative;z-index:1}
.ctr-unit{flex:1;text-align:center}
.ctr-num{font-family:'Cormorant Garamond',serif;font-size:clamp(32px,10vw,56px);font-weight:700;line-height:1;color:var(--ink);display:block}
.ctr-nsm{font-family:'Cormorant Garamond',serif;font-size:clamp(22px,7vw,38px);font-weight:700;line-height:1;color:var(--ink);display:block}
.ctr-nsm.pop,.ctr-num.pop{animation:nPop .2s ease}@keyframes nPop{0%,100%{transform:scale(1)}40%{transform:scale(1.06)}}
.ctr-sep{font-family:'Cormorant Garamond',serif;font-size:clamp(22px,6vw,34px);color:var(--accent);opacity:.25;align-self:flex-end;padding-bottom:clamp(6px,2vw,10px);flex-shrink:0;line-height:1;width:clamp(12px,3.5vw,18px);text-align:center}
.ctr-sepsm{font-family:'Cormorant Garamond',serif;font-size:clamp(16px,4.5vw,24px);color:var(--accent);opacity:.28;align-self:flex-end;padding-bottom:clamp(4px,1.5vw,5px);flex-shrink:0;line-height:1;width:clamp(10px,2.5vw,13px);text-align:center}
.ctr-ul{font-size:clamp(7px,2vw,9px);font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--ink);opacity:.55;margin-top:4px;text-align:center}
.mood-row{display:flex;gap:2px;overflow-x:auto;padding:2px 0 4px}
.mb{font-size:clamp(22px,7vw,28px);background:none;border:none;cursor:pointer;padding:6px 5px;border-radius:12px;transition:transform .15s;flex-shrink:0;position:relative}
.mb:active{transform:scale(.86)}.mb.on{background:color-mix(in srgb,var(--accent) 12%,transparent)}
.mb.on::after{content:'';position:absolute;bottom:3px;left:50%;transform:translateX(-50%);width:4px;height:4px;background:var(--accent);border-radius:50%}
.note-bar{display:flex;align-items:center;gap:8px;background:color-mix(in srgb,var(--ink) 6%,transparent);border-radius:50px;padding:9px 13px;margin-top:10px}
.chat-scroll{height:210px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:2px 2px 4px}
.chat-row{display:flex;justify-content:flex-start}
.chat-row.me{justify-content:flex-end}
.chat-bubble{max-width:78%;padding:8px 13px;border-radius:16px;font-size:13px;line-height:1.45;word-break:break-word;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.chat-time{font-size:9px;color:var(--muted);margin-top:2px;padding:0 4px}
.note-inp{flex:1;border:none;background:none;font-size:14px;color:var(--ink);outline:none}.note-inp::placeholder{color:var(--muted)}
.btn-p{width:100%;padding:13px;background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 80%,#f99));color:#fff;border:none;border-radius:13px;font-size:14px;font-weight:600;letter-spacing:.04em;cursor:pointer}
.btn-p:active{opacity:.82}.btn-p.danger{background:linear-gradient(135deg,#e05050,#f07070)!important}
.btn-g{background:none;border:none;cursor:pointer;font-size:12px;font-weight:600;color:var(--accent)}
.btn-i{width:38px;height:38px;border-radius:50%;background:var(--rose);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:transform .15s;color:var(--ink)}
.btn-i:active{transform:scale(.88)}.btn-ia{background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 80%,#f99))!important;box-shadow:0 4px 14px color-mix(in srgb,var(--accent) 35%,transparent)}.btn-ia svg{stroke:#fff!important}
.btn-sm{padding:7px 12px;background:var(--rose);border:none;border-radius:50px;font-size:12px;font-weight:600;color:var(--accent);cursor:pointer;white-space:nowrap}.btn-sm.on{background:var(--accent);color:#fff}
.nav-item{display:flex;flex-direction:column;align-items:center;gap:2px;background:none;border:none;cursor:pointer;padding:5px 7px;border-radius:12px;min-width:48px;flex-shrink:0}
.nav-ic{color:var(--muted);transition:color .2s;display:flex}.nav-lb{font-size:clamp(7px,2vw,9px);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);transition:color .2s;white-space:nowrap}
.nav-item.on .nav-ic,.nav-item.on .nav-lb{color:var(--accent)}
.auth-wrap{position:absolute;inset:0;background:radial-gradient(circle at 50% 18%,${t.rose} 0%,${t.bg} 62%);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:clamp(24px,6vw,40px) 28px;z-index:90;overflow:hidden}
.auth-wrap::before{content:'';position:absolute;top:-90px;right:-70px;width:220px;height:220px;background:radial-gradient(circle,${t.accent}22,transparent 70%);border-radius:50%;pointer-events:none}
.auth-wrap::after{content:'';position:absolute;bottom:-100px;left:-80px;width:240px;height:240px;background:radial-gradient(circle,${t.accent}18,transparent 70%);border-radius:50%;pointer-events:none}
.auth-wrap>*{position:relative;z-index:1}
.auth-heart{font-size:clamp(40px,11vw,52px);margin-bottom:16px;animation:hb 2.4s ease-in-out infinite}@keyframes hb{0%,100%{transform:scale(1)}35%{transform:scale(1.09)}65%{transform:scale(1)}}
.auth-title{font-family:'Cormorant Garamond',serif;font-size:clamp(34px,9vw,42px);font-weight:600;font-style:italic;color:var(--ink);margin-bottom:4px}
.auth-sub{font-size:13px;color:var(--slate);margin-bottom:28px;text-align:center;line-height:1.7}
.auth-field{width:100%;padding:13px 16px;border:1.5px solid var(--border);border-radius:13px;background:var(--sf);font-size:15px;color:var(--ink);outline:none;margin-bottom:10px}
.auth-field:focus{border-color:var(--aclt)}.auth-field.err{border-color:#e05050;animation:shake .4s ease}
@keyframes shake{0%,100%{transform:none}25%{transform:translateX(-8px)}75%{transform:translateX(8px)}}
.nfc-wrap{position:absolute;inset:0;background:radial-gradient(circle at 50% 18%,${t.rose} 0%,${t.bg} 62%);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 32px;z-index:80;overflow:hidden}
.nfc-wrap::before{content:'';position:absolute;top:-90px;right:-70px;width:220px;height:220px;background:radial-gradient(circle,${t.accent}22,transparent 70%);border-radius:50%;pointer-events:none}
.nfc-wrap::after{content:'';position:absolute;bottom:-100px;left:-80px;width:240px;height:240px;background:radial-gradient(circle,${t.accent}18,transparent 70%);border-radius:50%;pointer-events:none}
.nfc-wrap>*{position:relative;z-index:1}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:50;display:flex;align-items:flex-end;animation:fadeIn .18s ease}@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.sheet{background:var(--sf);border-radius:24px 24px 0 0;padding:14px 18px calc(env(safe-area-inset-bottom,0px) + 32px);width:100%;max-height:88vh;overflow-y:auto;animation:slideUp .24s cubic-bezier(.32,0,.16,1)}@keyframes slideUp{from{transform:translateY(100%)}to{transform:none}}
.sh-handle{width:34px;height:4px;background:var(--border);border-radius:2px;margin:0 auto 14px}
.sh-title{font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:var(--ink);margin-bottom:12px}
.field{width:100%;padding:11px 13px;border:1.5px solid var(--border);border-radius:12px;background:color-mix(in srgb,var(--ink) 4%,transparent);font-size:14px;color:var(--ink);outline:none;resize:none;transition:border-color .2s}.field:focus{border-color:var(--aclt);background:var(--sf)}
.fridge-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.sticky{border-radius:14px;padding:12px 12px 30px;height:150px;box-shadow:var(--sh);position:relative;cursor:pointer;transition:transform .12s}
.sticky:active{transform:scale(.97)}
.sticky-del{position:absolute;top:7px;right:7px;width:20px;height:20px;background:rgba(0,0,0,.1);border:none;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px;color:rgba(0,0,0,.45)}
.sticky-txt{font-size:13px;line-height:1.55;color:var(--ink);word-break:break-word;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:5;overflow:hidden}
.sticky-date{position:absolute;bottom:9px;left:12px;font-size:10px;color:rgba(0,0,0,.32);font-weight:500}
.sticky-badge{position:absolute;top:10px;left:10px;font-size:9px;font-weight:700;letter-spacing:.03em;color:#fff;padding:3px 9px;border-radius:50px;box-shadow:0 1px 4px rgba(0,0,0,.15)}
.col-row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 2px}.col-dot{width:26px;height:26px;border-radius:50%;border:none;cursor:pointer}.col-dot.sel{box-shadow:0 0 0 2.5px var(--sf),0 0 0 4.5px var(--accent)}
.tab-row{display:flex;border-bottom:1px solid var(--border);margin-bottom:12px;overflow-x:auto}
.tab{flex-shrink:0;padding:8px 12px;background:none;border:none;border-bottom:2px solid transparent;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;cursor:pointer;color:var(--muted);transition:.15s;white-space:nowrap}.tab.on{border-bottom-color:var(--accent);color:var(--accent)}
.map-frame{width:100%;height:clamp(220px,44vw,310px);border-radius:var(--r);border:none;box-shadow:var(--sh-md);margin-bottom:10px}
.mem-card{background:var(--sf);border-radius:13px;padding:12px 14px;margin-bottom:8px;display:flex;gap:11px;align-items:flex-start;box-shadow:var(--sh);cursor:pointer;transition:background .15s}.mem-card.sel{background:var(--rose)}
.mem-dot{width:34px;height:34px;background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 75%,#f99));border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#fff}
.pin-wrap{display:flex;flex-direction:column;align-items:center;padding:14px 0}
.pin-dots{display:flex;gap:14px;margin-bottom:28px}.pin-dot{width:13px;height:13px;border-radius:50%;border:2px solid var(--aclt);transition:.2s}.pin-dot.filled{background:var(--accent);border-color:var(--accent)}.pin-dot.err{background:#e05050;border-color:#e05050;animation:shake .4s ease}
.pin-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;width:100%;max-width:250px}
.pin-key{aspect-ratio:1;background:var(--sf);border-radius:50%;border:none;font-family:'Cormorant Garamond',serif;font-size:clamp(20px,6vw,26px);font-weight:600;color:var(--ink);cursor:pointer;box-shadow:var(--sh);display:flex;align-items:center;justify-content:center}.pin-key:active{transform:scale(.86);background:var(--rose)}
.photo-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;border-radius:14px;overflow:hidden}
.photo-cell{aspect-ratio:1;background:var(--rose);overflow:hidden;cursor:pointer;position:relative}.photo-cell img,.photo-cell video{width:100%;height:100%;object-fit:cover;display:block}
.av-ring{width:clamp(88px,22vw,102px);height:clamp(88px,22vw,102px);border-radius:50%;margin:0 auto 12px;overflow:hidden;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.1)}
.av-ph{display:flex;align-items:center;justify-content:center;font-size:clamp(32px,9vw,40px);background:linear-gradient(135deg,#2C2420,#4A3830);width:100%;height:100%}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.stat-box{background:var(--rose);border-radius:13px;padding:13px;text-align:center}
.stat-num{font-family:'Cormorant Garamond',serif;font-size:clamp(20px,5.5vw,26px);font-weight:700;color:var(--ink)}.stat-lbl{font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-top:3px}
.srow{display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid var(--border)}.srow:last-child{border-bottom:none}
.profs-row{display:flex;justify-content:center;align-items:center;gap:clamp(14px,4.5vw,28px);padding:8px 0 4px}
.prof-item{display:flex;flex-direction:column;align-items:center;gap:6px}
.prof-circle{width:clamp(62px,17vw,76px);height:clamp(62px,17vw,76px);border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;cursor:pointer}
.av-wrap{position:relative;display:inline-block}
.mood-badge{position:absolute;bottom:-2px;right:-2px;border-radius:50%;background:var(--sf);box-shadow:0 2px 6px rgba(0,0,0,.22);display:flex;align-items:center;justify-content:center;border:2px solid var(--sf)}
.prof-me{background:linear-gradient(135deg,#2C2420,#4A3830)}.prof-them{background:var(--rose);border:2px dashed var(--border)}
.dist-card{background:var(--sf);border-radius:var(--r);padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:12px;box-shadow:var(--sh);cursor:pointer;flex-wrap:wrap}
.dist-icon{width:42px;height:42px;background:var(--rose);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.dist-bar{height:4px;background:var(--border);border-radius:2px;overflow:hidden;margin:6px 0}
.dist-fill{height:100%;background:linear-gradient(90deg,var(--accent),color-mix(in srgb,var(--accent) 60%,#f99));border-radius:2px;transition:width .5s ease}
.empty{text-align:center;padding:clamp(28px,8vw,48px) 20px;color:var(--muted)}.empty-e{font-size:clamp(34px,9vw,42px);margin-bottom:12px}.empty-t{font-size:14px;line-height:1.65}
.row-bw{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.lb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:60;display:flex;align-items:center;justify-content:center;padding:16px}
.editable-title{display:flex;align-items:center;gap:6px}.edit-pen{background:none;border:none;cursor:pointer;color:var(--muted);display:flex;padding:2px;opacity:.6}
.theme-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
.theme-card{border-radius:14px;padding:14px;text-align:center;cursor:pointer;border:2px solid transparent;transition:.18s}.theme-card.sel{border-color:var(--accent)}
.sync-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:5px}.sync-dot.on{background:#4CAF50}.sync-dot.off{background:#aaa}
.priv-banner{background:color-mix(in srgb,var(--accent) 10%,transparent);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:12px;font-size:12px;color:var(--slate);line-height:1.6;text-align:center}
/* Date planner specific */
.place-card{background:var(--sf);border-radius:var(--r);padding:16px;margin-bottom:10px;box-shadow:var(--sh);border:1.5px solid var(--border)}
.halal-badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:50px;font-size:11px;font-weight:700;letter-spacing:.05em}
.halal-yes{background:#d4f5d4;color:#2a7a3a}.halal-no{background:#fdd4d4;color:#a02020}.halal-unknown{background:color-mix(in srgb,var(--ink) 8%,transparent);color:var(--muted)}
.place-quote{font-size:12px;font-style:italic;color:var(--slate);background:color-mix(in srgb,var(--ink) 5%,transparent);border-radius:8px;padding:8px 10px;margin:8px 0;border-left:3px solid var(--aclt)}
.search-spinner{display:flex;flex-direction:column;align-items:center;padding:40px 20px;gap:14px;color:var(--muted)}
.spinner{width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.date-history-card{background:var(--sf);border-radius:13px;padding:12px 14px;margin-bottom:8px;box-shadow:var(--sh)}
.ideas-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.idea-card{background:var(--sf);border-radius:14px;padding:14px 10px;text-align:center;cursor:pointer;box-shadow:var(--sh);transition:transform .12s}.idea-card:active{transform:scale(.95)}
.conf-row{display:flex;gap:10px;margin-top:4px}
  @keyframes confettiFall{0%{transform:translateY(-10px) rotate(0deg);opacity:1}100%{transform:translateY(110vh) rotate(800deg);opacity:0}}
  @keyframes introIn{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
  @keyframes heartPulse{0%,100%{transform:scale(1)}40%{transform:scale(1.18)}}
  .intro-screen{position:fixed;inset:0;background:var(--bg);z-index:75;display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:clamp(28px,7vw,52px) 26px clamp(24px,6vw,40px);overflow:hidden}
  .intro-slide{animation:introIn .38s cubic-bezier(.32,0,.16,1) forwards;display:flex;flex-direction:column;align-items:center;flex:1;justify-content:center;width:100%}
  .intro-emoji{font-size:clamp(56px,14vw,76px);line-height:1;margin-bottom:clamp(18px,4vw,26px)}
  .intro-title{font-family:'Cormorant Garamond',serif;font-size:clamp(26px,7.5vw,38px);font-weight:600;font-style:italic;color:var(--ink);margin-bottom:clamp(12px,3vw,18px);text-align:center;line-height:1.2}
  .intro-body{font-size:clamp(13px,3.6vw,15px);color:var(--slate);text-align:center;line-height:1.85;max-width:310px}
  .intro-sub{font-size:clamp(15px,4vw,18px);font-family:'Cormorant Garamond',serif;font-style:italic;color:var(--accent);margin-top:12px;text-align:center}
  .intro-tag{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);opacity:.7;margin-top:10px;text-align:center}
  .intro-dots{display:flex;gap:7px;justify-content:center;margin:clamp(14px,3.5vw,22px) 0;flex-shrink:0}
  .intro-dot{width:7px;height:7px;border-radius:50%;background:var(--border);transition:.3s ease}
  .intro-dot.on{background:var(--accent);width:22px;border-radius:50px}
  .intro-btns{display:flex;gap:10px;width:100%;max-width:290px;flex-shrink:0}
  .bday-card-today{background:linear-gradient(135deg,var(--deep) 0%,var(--rose) 100%);border-radius:var(--r);padding:18px;margin-bottom:10px;box-shadow:var(--sh);text-align:center;position:relative;overflow:hidden}
  .bday-card-norm{background:var(--sf);border-radius:var(--r);padding:16px 18px;margin-bottom:10px;box-shadow:var(--sh)}
  .bday-soon-badge{font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);display:block;margin-top:2px}
${theme==='claudetest'?`
/* ── Claude Theme Test — opt-in polish pass, only active on this theme ── */
body{background:radial-gradient(ellipse 900px 500px at 50% -8%,${t.rose} 0%,${t.bg} 60%)}
.card{background:linear-gradient(160deg,color-mix(in srgb,${t.sf} 94%,#fff 6%) 0%,${t.sf} 100%);border:1px solid ${t.accent}20;box-shadow:0 1px 0 ${t.accent}14 inset,0 12px 30px rgba(0,0,0,.3)}
.card-title{position:relative;padding-left:13px}
.card-title::before{content:'';position:absolute;left:0;top:50%;transform:translateY(-50%);width:4px;height:15px;background:linear-gradient(${t.accent},color-mix(in srgb,${t.accent} 55%,#fff 45%));border-radius:3px}
.btn-p{background:linear-gradient(155deg,color-mix(in srgb,${t.accent} 90%,#fff 18%),${t.accent} 55%,color-mix(in srgb,${t.accent} 82%,#000 18%));box-shadow:0 1px 0 rgba(255,255,255,.28) inset,0 10px 22px ${t.accent}40;letter-spacing:.04em;transition:transform .12s}
.btn-p:active{transform:translateY(1px) scale(.99)}
.us-hdr{background:linear-gradient(${t.bg},${t.bg}00)!important}
.us-nav{position:relative}
.us-nav::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,${t.accent}66,transparent)}
.ctr-card{box-shadow:0 16px 36px rgba(0,0,0,.38),0 0 0 1px ${t.accent}22 inset}
.sticky,.dist-card,.place-card,.mem-card,.date-history-card,.theme-card,.stat-box{box-shadow:0 8px 22px rgba(0,0,0,.24)!important}
.auth-title,.logo{text-shadow:0 2px 16px ${t.accent}40}
.btn-i.btn-ia{box-shadow:0 8px 18px ${t.accent}48!important}
.pin-key,.av-ring,.prof-circle{box-shadow:0 8px 20px rgba(0,0,0,.28)!important}
`:''}
`;}

/* ── Icons ──────────────────────────────────────────────── */
const SB=({w=21,h=21,sw="1.8",ch,...p})=><svg width={w} height={h} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" {...p}>{ch}</svg>;
const IcHome   =()=><SB ch={<><path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H5a1 1 0 01-1-1V9.5z"/><polyline points="9,21 9,12 15,12 15,21"/></>}/>;
const IcMe     =()=><SB ch={<><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></>}/>;
const IcFridge =()=><SB ch={<><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="5" y1="10" x2="19" y2="10"/><line x1="10" y1="15" x2="10" y2="18"/></>}/>;
const IcDates  =()=><SB ch={<><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></>}/>;
const IcMap    =()=><SB ch={<><polygon points="3,6 9,3 15,6 21,3 21,18 15,21 9,18 3,21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></>}/>;
const IcGallery=()=><SB ch={<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>}/>;
const IcNotes  =()=><SB ch={<><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></>}/>;
const IcGear   =()=><SB sw="1.9" ch={<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></>}/>;
const IcPlus   =()=><SB w={17} h={17} sw="2.5" ch={<><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>}/>;
const IcSend   =()=><SB w={15} h={15} sw="2.1" ch={<><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22,2 15,22 11,13 2,9"/></>}/>;
const IcPin    =()=><SB w={15} h={15} sw="2" ch={<><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5" fill="currentColor" stroke="none"/></>}/>;
const IcTrash  =()=><SB w={14} h={14} sw="2" ch={<><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></>}/>;
const IcX      =()=><SB w={11} h={11} sw="2.6" ch={<><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>}/>;
const IcCheck  =()=><SB w={14} h={14} sw="2.5" ch={<><polyline points="20,6 9,17 4,12"/></>}/>;
const IcBack   =()=><SB sw="2" ch={<><polyline points="15,18 9,12 15,6"/></>}/>;
const IcCam    =()=><SB w={19} h={19} ch={<><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></>}/>;
const IcPen    =()=><SB w={13} h={13} sw="2" ch={<><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></>}/>;
const IcChevD  =()=><SB w={14} h={14} sw="2.2" ch={<><polyline points="6,9 12,15 18,9"/></>}/>;
const IcHeart  =()=><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.08C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/></svg>;
const IcStar   =()=><SB w={14} h={14} sw="1.5" ch={<><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26 12,2" fill="currentColor" stroke="none"/></>}/>;
const IcSearch =()=><SB w={16} h={16} sw="2" ch={<><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>}/>;
const NAV_ICS={home:IcHome,me:IcMe,fridge:IcFridge,dates:IcDates,map:IcMap,gallery:IcGallery,notes:IcNotes,settings:IcGear};

/* ── Confirm Dialog ─────────────────────────────────────── */
function ConfirmDialog({msg,onYes,onNo}){
  return(
    <div className="overlay" onClick={onNo}>
      <div className="sheet" onClick={e=>e.stopPropagation()}>
        <div className="sh-handle"/>
        <h3 className="sh-title">Are you sure?</h3>
        <p className="cap" style={{marginBottom:20}}>{msg}</p>
        <div className="conf-row">
          <button className="btn-p" style={{background:"var(--rose)",color:"var(--ink)"}} onClick={onNo}>Cancel</button>
          <button className="btn-p danger" onClick={onYes}>Delete</button>
        </div>
      </div>
    </div>
  );
}
function useConfirm(){
  const [state,setState]=useState(null);
  const ask=(msg,onYes)=>setState({msg,onYes});
  const dialog=state?<ConfirmDialog msg={state.msg} onYes={()=>{state.onYes();setState(null);}} onNo={()=>setState(null)}/>:null;
  return[ask,dialog];
}

/* ── EditTitle ──────────────────────────────────────────── */
function EditTitle({value,onSave}){
  const[ed,setEd]=useState(false);
  const[dr,setDr]=useState(value);
  if(ed)return(
    <div style={{display:"flex",gap:6,alignItems:"center"}}>
      <input className="field" style={{padding:"4px 8px",fontSize:14,width:"auto"}} value={dr} autoFocus
        onChange={e=>setDr(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){onSave(dr);setEd(false);}if(e.key==="Escape")setEd(false);}}/>
      <button className="btn-i" style={{width:28,height:28}} onClick={()=>{onSave(dr);setEd(false);}}><IcCheck/></button>
    </div>
  );
  return(<div className="editable-title"><span className="sec-title" style={{marginBottom:0}}>{value}</span><button className="edit-pen" onClick={()=>{setDr(value);setEd(true);}}><IcPen/></button></div>);
}

/* ── Settings row + sheet — tap a row, a focused sheet pops up ──────────── */
function SettingsRow({label,value,onClick}){
  return(
    <button className="srow" style={{width:"100%",background:"none",border:"none",cursor:"pointer",textAlign:"left"}} onClick={onClick}>
      <span style={{fontSize:14,fontWeight:500,color:"var(--ink)"}}>{label}</span>
      <span style={{display:"flex",alignItems:"center",gap:6}}>
        {value&&<span className="cap">{value}</span>}
        <span style={{display:"flex",color:"var(--muted)",transform:"rotate(-90deg)"}}><IcChevD/></span>
      </span>
    </button>
  );
}
function SettingsSheet({title,onClose,children}){
  return(
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={e=>e.stopPropagation()}>
        <div className="sh-handle"/>
        <h3 className="sh-title">{title}</h3>
        {children}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   BIOMETRIC GATE  (Face ID / Touch ID / Fingerprint)
═══════════════════════════════════════════ */
function BiometricGate({onPass,onUnsupported}){
  const[state,setState]=useState("idle"); // idle|working|done|notsupported
  const[errMsg,setErrMsg]=useState("");
  const CRED="us_bio";

  // Check support on mount — don't auto-trigger, wait for user tap
  useEffect(()=>{
    if(!window.PublicKeyCredential){
      setState("notsupported");
    } else {
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
        .then(ok=>{ if(!ok)setState("notsupported"); })
        .catch(()=>setState("notsupported"));
    }
  },[]);

  // Registration uses a resident/discoverable credential, which the platform
  // authenticator stores in its own secure enclave — NOT in this browser's
  // localStorage. That's what makes it survive a history/site-data clear:
  // there's nothing local for the clear to wipe. `gs(CRED,...)` below is
  // only ever a cosmetic hint for which copy to show; the real check is
  // always attempting an actual unlock first.
  const doWebAuthn=async()=>{
    setState("working"); setErrMsg("");
    const challenge=window.crypto.getRandomValues(new Uint8Array(32));
    try{
      // Always try unlocking with whatever passkey this device already has
      // for this site first — works even after localStorage was wiped.
      await navigator.credentials.get({
        publicKey:{
          challenge,
          rpId:window.location.hostname,
          userVerification:"required",
          timeout:60000,
        }
      });
      ss(CRED,"1");
      setState("done"); onPass();
      return;
    }catch(e){
      // Only fall through to registering a new one if it looks like there's
      // genuinely nothing registered yet on this device. Anything else
      // (user cancelled, timed out) should stay on this screen as an error.
      if(e.name!=="NotAllowedError"){
        setState("idle"); setErrMsg(e.message||"Unknown error"); return;
      }
    }
    try{
      const cred=await navigator.credentials.create({
        publicKey:{
          challenge:window.crypto.getRandomValues(new Uint8Array(32)),
          rp:{name:"us.",id:window.location.hostname},
          user:{id:window.crypto.getRandomValues(new Uint8Array(16)),name:"us.user",displayName:"us."},
          pubKeyCredParams:[{type:"public-key",alg:-7},{type:"public-key",alg:-257}],
          authenticatorSelection:{authenticatorAttachment:"platform",residentKey:"required",requireResidentKey:true,userVerification:"required"},
          timeout:60000,
        }
      });
      if(cred)ss(CRED,"1");
      setState("done"); onPass();
    }catch(e){
      setState("idle");
      if(e.name==="NotAllowedError"){
        setErrMsg("Biometric was cancelled or not recognised. Try again.");
      } else {
        setErrMsg(e.message||"Unknown error");
      }
    }
  };

  const hasCredential=!!gs(CRED,null);

  if(state==="notsupported") return(
    <div className="nfc-wrap">
      <div style={{fontSize:"clamp(44px,12vw,56px)",marginBottom:16}}>🔐</div>
      <h2 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"clamp(22px,6vw,28px)",fontWeight:600,color:"var(--ink)",marginBottom:10,textAlign:"center"}}>Biometric unavailable</h2>
      <p style={{fontSize:14,color:"var(--muted)",textAlign:"center",lineHeight:1.75,maxWidth:280,marginBottom:24}}>
        This browser or device doesn't support Face ID / fingerprint unlock. You'll unlock with your NFC tag alone instead.
      </p>
      <button className="btn-p" style={{maxWidth:260,width:"100%"}} onClick={onUnsupported}>Continue →</button>
    </div>
  );

  if(state==="working") return(
    <div className="nfc-wrap">
      <div style={{fontSize:"clamp(44px,12vw,56px)",marginBottom:16}}>🔐</div>
      <div className="spinner" style={{margin:"16px auto"}}/>
      <p style={{fontSize:14,color:"var(--muted)",textAlign:"center",marginTop:10}}>
        {hasCredential?"Waiting for biometric…":"Follow the on-screen prompt to register…"}
      </p>
    </div>
  );

  return(
    <div className="nfc-wrap">
      <div style={{fontSize:"clamp(44px,12vw,56px)",marginBottom:16,animation:"hb 2s ease infinite"}}>
        {hasCredential?"🔐":"👆"}
      </div>
      <h2 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"clamp(22px,6vw,28px)",fontWeight:600,color:"var(--ink)",marginBottom:10,textAlign:"center"}}>
        {hasCredential?"Verify it's you":"Set up biometric"}
      </h2>
      <p style={{fontSize:14,color:"var(--muted)",textAlign:"center",lineHeight:1.75,maxWidth:280,marginBottom:24}}>
        {hasCredential
          ?"Use Face ID or fingerprint to unlock us."
          :"Required — set up Face ID or fingerprint now. You only register once; every unlock after this uses it instead of your password."}
      </p>
      {errMsg&&<p style={{color:"#e05050",fontSize:13,textAlign:"center",marginBottom:16,maxWidth:260}}>{errMsg}</p>}
      <button className="btn-p" style={{maxWidth:260,width:"100%",marginBottom:14}} onClick={doWebAuthn}>
        {hasCredential?"🔐 Unlock with Biometric":"👆 Set Up Biometric"}
      </button>
    </div>
  );
}


/* ═══════════════════════════════════════════
   NFC GATE  — Web NFC on Android, URL fallback on iOS
═══════════════════════════════════════════ */
function NFCGate({onPass}){
  const[mode,setMode]=useState("checking"); // checking | scanning | ios | error
  const[tagErr,setTagErr]=useState("");

  useEffect(()=>{
    // ── 1. URL token present (NFC tag opened a link — iOS / direct URL) ──
    const p=new URLSearchParams(window.location.search);
    const token=p.get("nfc");
    if(token){
      window.history.replaceState({},"","/"); // wipe token from address bar immediately
      if(nfcValidateToken(token)){onPass();return;}
      setTagErr("Invalid tag. Make sure you are using your us. tag.");
    }

    // ── 3. Web NFC API — Android Chrome only ──────────────
    if("NDEFReader" in window){
      setMode("scanning");
      let ctrl=new AbortController();
      (async()=>{
        try{
          const reader=new NDEFReader();
          await reader.scan({signal:ctrl.signal});
          reader.addEventListener("reading",({message})=>{
            for(const record of message.records){
              // Extract text from the record regardless of type
              let text="";
              try{
                const bytes=new Uint8Array(record.data);
                const full=new TextDecoder().decode(record.data);
                const skip=new TextDecoder().decode(bytes.slice(1));
                // URL records prefix the actual URL with a 1-byte scheme code
                // Try both full and skip-first-byte to catch all encoding variants
                text=full.includes(NFC_TOKEN)?full:skip;
              }catch(e){}
              if(text.includes(NFC_TOKEN)){
                ctrl.abort();
                onPass();
                return;
              }
            }
            setTagErr("Wrong tag — use your us. tag.");
            setTimeout(()=>setTagErr(""),3000);
          });
          reader.addEventListener("readingerror",()=>{
            setTagErr("Could not read tag. Hold it still and try again.");
            setTimeout(()=>setTagErr(""),3000);
          });
        }catch(e){
          if(e.name!=="AbortError"){
            // Permission denied or not supported
            setMode("ios");
          }
        }
      })();
      return()=>ctrl.abort();
    } else {
      // iOS Safari — no Web NFC support
      setMode("ios");
    }
  },[]);

  const wrap=(icon,title,body,extra=null)=>(
    <div className="nfc-wrap">
      <div style={{fontSize:"clamp(44px,12vw,56px)",marginBottom:16,animation:"hb 2s ease infinite"}}>{icon}</div>
      <h2 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"clamp(24px,6.5vw,30px)",fontWeight:600,color:"var(--ink)",marginBottom:10,textAlign:"center"}}>{title}</h2>
      <p style={{fontSize:14,color:"var(--muted)",textAlign:"center",lineHeight:1.75,maxWidth:280}}>{body}</p>
      {extra}
      {tagErr&&<p style={{marginTop:14,fontSize:13,color:"#e05050",textAlign:"center",maxWidth:260}}>{tagErr}</p>}
    </div>
  );

  const[introToggle,setIntroToggle]=useState(()=>gs('show_intro_on_scan',false));
  const toggleIntro=v=>{setIntroToggle(v);ss('show_intro_on_scan',v);};

  const toggleEl=(
    <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',marginTop:22,userSelect:'none'}}>
      <div onClick={()=>toggleIntro(!introToggle)} style={{width:38,height:22,background:introToggle?'var(--accent)':'var(--border)',borderRadius:50,position:'relative',transition:'.2s',flexShrink:0}}>
        <div style={{position:'absolute',top:3,left:introToggle?17:3,width:16,height:16,background:'#fff',borderRadius:'50%',transition:'.2s',boxShadow:'0 1px 4px rgba(0,0,0,.2)'}}/>
      </div>
      <span style={{fontSize:12,color:'var(--muted)',fontWeight:500}}>Show welcome on unlock</span>
    </label>
  );

  if(mode==="scanning") return wrap(
    "📱",
    "Hold tag to unlock",
    "Bring your NFC tag to the back of your phone. No links will open — the app unlocks directly.",
    toggleEl
  );

  if(mode==="ios") return wrap(
    "🔒",
    "us.",
    <>
      Scan your NFC tag with your camera or NFC app.
      <br/><br/>
      It will open a link — tap <strong>Open</strong> and you will be let in automatically. You'll need to scan again every time you reload or reopen the app.
    </>,
    toggleEl
  );

  // Checking state (brief flash)
  return wrap("💕","us.","One moment…");
}

/* ═══════════════════════════════════════════
   ERROR BOUNDARY
═══════════════════════════════════════════ */
class ErrorBoundary extends React.Component{
  constructor(p){super(p);this.state={err:null};}
  static getDerivedStateFromError(e){return{err:e};}
  render(){
    if(this.state.err){
      return(
        <div style={{padding:32,textAlign:"center",fontFamily:"Inter,sans-serif",
          background:"#FCF0EC",height:"100dvh",display:"flex",flexDirection:"column",
          alignItems:"center",justifyContent:"center",gap:12}}>
          <div style={{fontSize:40}}>💔</div>
          <h2 style={{fontFamily:"Georgia,serif",fontStyle:"italic",fontSize:22,color:"#1A1512"}}>
            Something went wrong
          </h2>
          <p style={{fontSize:13,color:"#7A6560",maxWidth:280,lineHeight:1.7}}>
            {this.state.err.message||"Unknown error"}
          </p>
          <button onClick={()=>this.setState({err:null})}
            style={{marginTop:8,padding:"11px 22px",background:"#C45450",color:"#fff",
              border:"none",borderRadius:50,fontSize:13,fontWeight:600,cursor:"pointer"}}>
            Try again
          </button>
          <button onClick={()=>window.location.reload()}
            style={{padding:"9px 20px",background:"none",color:"#C45450",border:"1px solid #C45450",
              borderRadius:50,fontSize:12,fontWeight:600,cursor:"pointer"}}>
            Reload app
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ═══════════════════════════════════════════
   AUTH SCREEN
═══════════════════════════════════════════ */
function AuthScreen({onAuth,initFbKey,initFbUrl,onFbSave}){
  // Hardcode your actual credentials here so they are permanently saved in the code
  const[fbKey,setFbKey]=useState("AIzaSyAc1LN7uRNdrSkejFXdjh8CiCQJPCIYU1A"); 
  const[fbUrl,setFbUrl]=useState("https://ustag-22e9c-default-rtdb.firebaseio.com");
  const[fbReady,setFbReady]=useState(true); // Always true so the setup screen is bypassed
  const[mode,setMode]=useState("signin");
  const[email,setEmail]=useState("");
  const[pw,setPw]=useState("");
  const[err,setErr]=useState("");
  const[busy,setBusy]=useState(false);
  const[regCount,setRegCount]=useState(null);
  const[resetMode,setResetMode]=useState(false);
  const[resetStep,setResetStep]=useState("form");
  const[resetToken,setResetToken]=useState("");
  const[resetOtp,setResetOtp]=useState("");
  const[newPw,setNewPw]=useState("");
  const[confirmPw,setConfirmPw]=useState("");
  const[resetEmail,setResetEmail]=useState("");
  const[resetBusy,setResetBusy]=useState(false);

  useEffect(()=>{
    if(fbReady) dbGet("meta/registered_count").then(v=>setRegCount(v||0));
  },[fbReady]);

  const saveFirebase=()=>{
    if(!fbKey.trim()||!fbUrl.trim()){setErr("Both fields are required.");return;}
    FIREBASE_API_KEY=fbKey.trim();
    FIREBASE_DB_URL=fbUrl.trim();
    onFbSave(fbKey.trim(),fbUrl.trim());
    setFbReady(true);
    setErr("");
  };

  useEffect(()=>{
    if(fbReady) dbGet("meta/registered_count").then(v=>setRegCount(v||0));
  },[fbReady]);

  // ── Step 1: Firebase not set up yet ─────────────────────
  if(!fbReady) return(
    <div className="auth-wrap">
      <div className="auth-heart">⚙️</div>
      <h1 className="auth-title" style={{fontSize:"clamp(24px,7vw,34px)"}}>One-time setup</h1>
      <p className="auth-sub">Paste your two Firebase details below.<br/>You only do this once.</p>
      <input className={`auth-field${err?" err":""}`} placeholder="Firebase API Key  (starts with AIzaSy…)" value={fbKey} onChange={e=>setFbKey(e.target.value)}/>
      <input className={`auth-field${err?" err":""}`} placeholder="Database URL  (ends with .firebasedatabase.app)" value={fbUrl} onChange={e=>setFbUrl(e.target.value)} onKeyDown={e=>e.key==="Enter"&&saveFirebase()}/>
      {err&&<p style={{color:"#e05050",fontSize:13,marginBottom:10,textAlign:"center"}}>{err}</p>}
      <button className="btn-p" onClick={saveFirebase}>Continue →</button>
      <p className="cap" style={{textAlign:"center",marginTop:14,lineHeight:1.7}}>
        Firebase Console → Project Settings<br/>→ Your apps → web icon → copy apiKey and databaseURL
      </p>
    </div>
  );

  // ── Step 2: Normal login + OTP reset ──────────────────
  const sendOtp=async()=>{
    if(!resetEmail.trim()){setErr("Enter your email first.");return;}
    setResetBusy(true);setErr("");
    try{
      const resp=await fetch("/.netlify/functions/send-otp",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({email:resetEmail.trim()})
      });
      const data=await resp.json();
      if(data.error){setErr(data.error);setResetBusy(false);return;}
      setResetToken(data.token);
      setResetStep("code");
      setResetOtp("");
    }catch(e){setErr("Network error. Check your connection.");}
    setResetBusy(false);
  };

  const doReset=async()=>{
    if(newPw.length<6){setErr("Password must be at least 6 characters.");return;}
    if(newPw!==confirmPw){setErr("Passwords do not match.");return;}
    setResetBusy(true);setErr("");
    try{
      const resp=await fetch("/.netlify/functions/reset-password",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({email:resetEmail.trim(),otp:resetOtp,token:resetToken,new_password:newPw})
      });
      const data=await resp.json();
      if(data.error){setErr(data.error);setResetBusy(false);return;}
      setResetStep("done");
    }catch(e){setErr("Network error. Check your connection.");}
    setResetBusy(false);
  };

  // ── Reset password view ──────────────────────────────
  if(resetMode)return(
    <div className="auth-wrap">
      <div className="auth-heart">{resetStep==="done"?"✅":"🔑"}</div>
      <h1 className="auth-title" style={{fontSize:"clamp(22px,6.5vw,30px)"}}>
        {resetStep==="form"?"Forgot Password":resetStep==="code"?"Enter Code":resetStep==="newpw"?"New Password":"All done!"}
      </h1>

      {resetStep==="form"&&<div style={{width:"100%"}}>
        <p className="auth-sub" style={{marginBottom:20}}>Enter your email and we'll send a 6-digit reset code straight to your inbox.</p>
        <input className={`auth-field${err?" err":""}`} type="email" placeholder="Your email"
          value={resetEmail} onChange={e=>setResetEmail(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&sendOtp()} autoFocus/>
        {err&&<p style={{color:"#e05050",fontSize:13,marginBottom:10,textAlign:"center"}}>{err}</p>}
        <button className="btn-p" style={{marginBottom:12}} onClick={sendOtp} disabled={resetBusy}>
          {resetBusy?"Sending code…":"Send Code →"}
        </button>
        <button className="btn-g" onClick={()=>{setResetMode(false);setErr("");}}>← Back to Sign In</button>
      </div>}

      {resetStep==="code"&&<div style={{width:"100%"}}>
        <p className="auth-sub" style={{marginBottom:20}}>
          A 6-digit code was sent to <strong>{resetEmail}</strong>.<br/>
          Check your inbox — it arrives within 30 seconds.
        </p>
        <input className={`auth-field${err?" err":""}`} type="text" inputMode="numeric"
          placeholder="000000" maxLength={6} value={resetOtp}
          onChange={e=>setResetOtp(e.target.value.replace(/\D/g,""))} autoFocus
          style={{textAlign:"center",letterSpacing:10,fontSize:26}}/>
        {err&&<p style={{color:"#e05050",fontSize:13,marginBottom:10,textAlign:"center"}}>{err}</p>}
        <button className="btn-p" style={{marginBottom:10}} onClick={()=>{if(resetOtp.length===6){setResetStep("newpw");setErr("");}else setErr("Enter the full 6-digit code.");}} disabled={resetBusy}>
          Verify Code →
        </button>
        <button className="btn-g" style={{marginBottom:8}} onClick={()=>{sendOtp();}}>Resend code</button>
        <button className="btn-g" onClick={()=>{setResetStep("form");setErr("");}}>← Change email</button>
      </div>}

      {resetStep==="newpw"&&<div style={{width:"100%"}}>
        <p className="auth-sub" style={{marginBottom:20}}>Choose a new password for your account.</p>
        <input className={`auth-field${err?" err":""}`} type="password" placeholder="New password (min 6 characters)"
          value={newPw} onChange={e=>setNewPw(e.target.value)} autoFocus/>
        <input className={`auth-field${err?" err":""}`} type="password" placeholder="Confirm new password"
          value={confirmPw} onChange={e=>setConfirmPw(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&doReset()}/>
        {err&&<p style={{color:"#e05050",fontSize:13,marginBottom:10,textAlign:"center"}}>{err}</p>}
        <button className="btn-p" onClick={doReset} disabled={resetBusy}>
          {resetBusy?"Updating password…":"Set New Password"}
        </button>
      </div>}

      {resetStep==="done"&&<div style={{width:"100%"}}>
        <div style={{background:"#e8f5e9",borderRadius:14,padding:"18px",marginBottom:20,textAlign:"center"}}>
          <p style={{fontSize:15,fontWeight:600,color:"#2e7d32",marginBottom:4}}>Password updated!</p>
          <p style={{fontSize:13,color:"#388e3c"}}>Sign in below with your new password.</p>
        </div>
        <button className="btn-p" onClick={()=>{setResetMode(false);setResetStep("form");setErr("");setNewPw("");setConfirmPw("");}}>
          Back to Sign In
        </button>
      </div>}
    </div>
  );

  // ── Normal sign in / register ────────────────────────
  const submit=async()=>{
    if(!email||!pw){setErr("Please fill in both fields.");return;}
    setBusy(true);setErr("");
    try{
      const d=mode==="signup"?await fbSignUp(email,pw):await fbSignIn(email,pw);
      if(mode==="signup"){
        const newCount=(regCount||0)+1;
        await dbWrite("meta/registered_count",newCount);
      }
      persistAuthSession(d);
      onAuth(d.email);
    }catch(e){setErr(e.message);}
    setBusy(false);
  };

  return(
    <div className="auth-wrap">
      <div className="auth-heart">💕</div>
      <h1 className="auth-title">us.</h1>
      <p className="auth-sub">{mode==="signup"?"Create your account":"Welcome back"}</p>
      <input className={`auth-field${err?" err":""}`} type="email" placeholder="Email" value={email}
        onChange={e=>{setEmail(e.target.value);setResetEmail(e.target.value);}} autoComplete="email"/>
      <input className={`auth-field${err?" err":""}`} type="password"
        placeholder={mode==="signup"?"Choose a password":"Password"} value={pw}
        onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}/>
      {err&&<p style={{color:"#e05050",fontSize:13,marginBottom:10,textAlign:"center"}}>{err}</p>}
      <button className="btn-p" style={{marginBottom:10}} onClick={submit} disabled={busy}>
        {busy?"…":mode==="signup"?"Create Account":"Sign In"}
      </button>
      {mode==="signin"&&<button className="btn-g" style={{marginBottom:6}} onClick={()=>{setResetMode(true);setResetStep("form");setErr("");}}>
        Forgot password?
      </button>}
      <button className="btn-g" onClick={()=>{setMode(m=>m==="signin"?"signup":"signin");setErr("");}}>
        {mode==="signin"?"First time? Register →":"Already registered? Sign in"}
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════
   COUNTER CARD
═══════════════════════════════════════════ */
function CounterCard({startDate}){
  const[t,setT]=useState(()=>calcE(startDate));
  const prevSc=useRef(t.sc);const[pop,setPop]=useState(false);
  useEffect(()=>{const tm=setInterval(()=>{const n=calcE(startDate);if(n.sc!==prevSc.current){setPop(true);setTimeout(()=>setPop(false),220);prevSc.current=n.sc;}setT(n);},500);return()=>clearInterval(tm);},[startDate]);
  return(
    <div className="ctr-card">
      <div className="ctr-ey"><span style={{color:"var(--accent)",display:"flex"}}><IcHeart/></span><span className="lbl" style={{color:"var(--ink)",opacity:.55}}>Together for</span></div>
      <div className="ctr-row" style={{marginBottom:4}}>
        <div className="ctr-unit"><span className="ctr-num">{pad(t.yr)}</span><div className="ctr-ul">Years</div></div>
        <div className="ctr-sep">·</div>
        <div className="ctr-unit"><span className="ctr-num">{pad(t.mo)}</span><div className="ctr-ul">Months</div></div>
        <div className="ctr-sep">·</div>
        <div className="ctr-unit"><span className="ctr-num">{pad(t.dy)}</span><div className="ctr-ul">Days</div></div>
      </div>
      <div className="ctr-row">
        <div className="ctr-unit"><span className="ctr-nsm">{pad(t.hr)}</span><div className="ctr-ul">Hrs</div></div>
        <div className="ctr-sepsm">:</div>
        <div className="ctr-unit"><span className="ctr-nsm">{pad(t.mn)}</span><div className="ctr-ul">Min</div></div>
        <div className="ctr-sepsm">:</div>
        <div className="ctr-unit"><span className={`ctr-nsm${pop?" pop":""}`}>{pad(t.sc)}</span><div className="ctr-ul">Sec</div></div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   MOOD CARD
═══════════════════════════════════════════ */
function ChatCard({myRole,theirRole,theirName}){
  const[messages,setMessages]=useSync("chat_messages",[]);
  const[draft,setDraft]=useState("");
  const scrollRef=useRef(null);
  useEffect(()=>{
    const el=scrollRef.current;
    if(el)el.scrollTop=el.scrollHeight;
  },[messages.length]);
  const send=()=>{
    if(!draft.trim())return;
    // Keep the synced payload bounded — this is a live 2-person chat, not an
    // archive; trimming old messages keeps every write small and instant.
    const next=[...messages,{id:Date.now()+Math.random(),text:draft.trim(),author:myRole,ts:Date.now()}].slice(-150);
    setMessages(next);
    setDraft("");
  };
  return(
    <div className="card" style={{paddingBottom:12}}>
      <div className="card-hdr" style={{marginBottom:6}}>
        <h3 className="card-title">Chat</h3>
        <span style={{fontSize:9,fontWeight:700,letterSpacing:".1em",textTransform:"uppercase",color:"#4CAF50",display:"flex",alignItems:"center",gap:4}}><span className="sync-dot on"/>Live</span>
      </div>
      <div ref={scrollRef} className="chat-scroll">
        {messages.length===0
          ?<div style={{margin:"auto",textAlign:"center",padding:"10px",color:"var(--muted)",fontSize:13}}>Say something to {theirName} 💬</div>
          :messages.map(m=>{
            const mine=m.author===myRole;
            return(
              <div key={m.id} className={`chat-row${mine?" me":""}`}>
                <div style={{display:"flex",flexDirection:"column",alignItems:mine?"flex-end":"flex-start"}}>
                  <div className="chat-bubble" style={{background:mine?"var(--accent)":`color-mix(in srgb, ${ROLE_COLORS[m.author]||"var(--ink)"} 16%, var(--rose))`,color:mine?"#fff":"var(--ink)"}}>{m.text}</div>
                  <span className="chat-time">{ago(m.ts)}</span>
                </div>
              </div>
            );
          })}
      </div>
      <div className="note-bar" style={{marginTop:8}}>
        <input className="note-inp" placeholder={`Message ${theirName}…`} value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>e.key==="Enter"&&send()}/>
        <button className="btn-i" style={{width:32,height:32,background:"var(--deep)"}} onClick={send}><IcSend/></button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   DISTANCE CARD
═══════════════════════════════════════════ */
function DistanceCard({myRole,theirRole}){
  const[myLoc,setMyLoc]=useSync("loc_"+myRole,null);
  const[theirLoc]=useSync("loc_"+theirRole,null);
  const[liveOn,setLiveOn]=useSync("live_loc_"+myRole,false);
  const[loading,setLoading]=useState(false);const[open,setOpen]=useState(false);
  const dist=myLoc&&theirLoc?hav(myLoc.lat,myLoc.lon,theirLoc.lat,theirLoc.lon):null;
  const sub=!myLoc?"Share your location":!theirLoc?"Waiting on them…":`${fmtDist(dist)} apart`;
  const pct=dist?Math.max(5,Math.min(95,100-dist/5)):0;
  const share=()=>{
    if(!navigator.geolocation){alert("Geolocation not supported.");return;}
    setLoading(true);
    navigator.geolocation.getCurrentPosition(p=>{setMyLoc({lat:p.coords.latitude,lon:p.coords.longitude,ts:Date.now()});setLoading(false);},
      ()=>{setLoading(false);alert("Location denied.\n\nFix: tap the lock icon in your browser address bar → Site Settings → Location → Allow.");},
      {enableHighAccuracy:true,timeout:12000});
  };
  return(
    <div className="dist-card" onClick={()=>setOpen(!open)}>
      <div style={{display:"flex",alignItems:"center",gap:12,flex:1,minWidth:0}}>
        <div className="dist-icon"><span style={{color:"var(--accent)",display:"flex"}}><IcPin/></span></div>
        <div style={{flex:1,minWidth:0}}>
          <div className="lbl" style={{marginBottom:3}}>Distance{liveOn&&<span style={{color:"#4CAF50"}}> · live</span>}</div>
          <div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"clamp(15px,4.5vw,18px)",fontWeight:600,color:"var(--ink)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{sub}</div>
          {dist!=null&&<div className="dist-bar"><div className="dist-fill" style={{width:`${pct}%`}}/></div>}
        </div>
        {myLoc&&<span style={{fontSize:11,color:"var(--muted)",flexShrink:0}}>{ago(myLoc.ts)}</span>}
        <span style={{color:"var(--muted)",transform:open?"rotate(180deg)":"",transition:".2s",display:"flex",flexShrink:0}}><IcChevD/></span>
      </div>
      {open&&<div style={{width:"100%",paddingTop:12,borderTop:"1px solid var(--border)",marginTop:10}} onClick={e=>e.stopPropagation()}>
        <label style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,cursor:"pointer",marginBottom:10}}>
          <span style={{fontSize:13,fontWeight:600,color:"var(--ink)"}}>Live Location</span>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div onClick={()=>setLiveOn(!liveOn)} style={{width:38,height:22,background:liveOn?"var(--accent)":"var(--border)",borderRadius:50,position:"relative",transition:".2s",flexShrink:0,cursor:"pointer"}}>
              <div style={{position:"absolute",top:3,left:liveOn?17:3,width:16,height:16,background:"#fff",borderRadius:"50%",transition:".2s",boxShadow:"0 1px 4px rgba(0,0,0,.2)"}}/>
            </div>
          </div>
        </label>
        <p className="cap" style={{marginBottom:10}}>{liveOn?"Updates automatically as you move, in the background — no need to tap the button.":"Off — your location only updates when you tap the button below."}</p>
        <button style={{width:"100%",padding:"10px",background:"var(--rose)",border:"none",borderRadius:11,fontSize:13,fontWeight:600,color:"var(--accent)",cursor:"pointer"}} onClick={share}>{loading?"Getting location…":"📍 Update My Location Now"}</button>
        {myLoc&&theirLoc&&<p style={{marginTop:8,fontSize:12,color:"var(--slate)",textAlign:"center"}}>Them last updated: {ago(theirLoc.ts)}</p>}
      </div>}
    </div>
  );
}

/* ═══════════════════════════════════════════
   PROFILE CIRCLES
═══════════════════════════════════════════ */
function ProfileCircles({myName,theirName,connEmoji,onEditEmoji,onMeClick,onThemClick,myRole,theirRole}){
  const[myPhoto]=useSync("photo_"+myRole,null);
  const[theirPhoto]=useSync("photo_"+theirRole,null);
  const[myMood]=useSync("mood_"+myRole,null);
  const[theirMood]=useSync("mood_"+theirRole,null);
  return(
    <div className="profs-row">
      <div className="prof-item" style={{cursor:"pointer"}} onClick={onMeClick}>
        <div className="av-wrap">
          <div className="prof-circle prof-me">{myPhoto?<img src={myPhoto} style={{width:"100%",height:"100%",objectFit:"cover"}} alt="me"/>:<div className="av-ph"><span style={{fontSize:"clamp(26px,8vw,32px)"}}>👤</span></div>}</div>
          {myMood&&<span className="mood-badge" style={{width:22,height:22,fontSize:13}}>{myMood}</span>}
        </div>
        <span style={{fontSize:9,fontWeight:700,letterSpacing:".1em",textTransform:"uppercase",color:"var(--muted)"}}>me</span>
        <span style={{fontSize:12,fontWeight:500,color:"var(--slate)"}}>{myName}</span>
      </div>
      <button style={{marginTop:-12,fontSize:"clamp(18px,5vw,22px)",background:"none",border:"none",cursor:"pointer"}} onClick={onEditEmoji}>{connEmoji||"💕"}</button>
      <div className="prof-item" style={{cursor:"pointer"}} onClick={onThemClick}>
        <div className="av-wrap">
          <div className="prof-circle prof-them">{theirPhoto?<img src={theirPhoto} style={{width:"100%",height:"100%",objectFit:"cover"}} alt="them"/>:<span style={{fontSize:"clamp(26px,8vw,32px)",color:"var(--muted)"}}>?</span>}</div>
          {theirMood&&<span className="mood-badge" style={{width:22,height:22,fontSize:13}}>{theirMood}</span>}
        </div>
        <span style={{fontSize:9,fontWeight:700,letterSpacing:".1em",textTransform:"uppercase",color:"var(--muted)"}}>them</span>
        <span style={{fontSize:12,fontWeight:500,color:"var(--slate)"}}>{theirName}</span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   HOME PAGE
═══════════════════════════════════════════ */
function HomePage({myName,theirName,startDate,nav,connEmoji,setConnEmoji,myRole,theirRole}){
  const[editConn,setEditConn]=useState(false);const[connDraft,setConnDraft]=useState(connEmoji||"💕");
  return(
    <div className="us-page pf">
      <CounterCard startDate={startDate}/>
      <BirthdayCard/>
      <ChatCard myRole={myRole} theirRole={theirRole} theirName={theirName}/>
      <DistanceCard myRole={myRole} theirRole={theirRole}/>
      <ProfileCircles myName={myName} theirName={theirName} connEmoji={connEmoji} onMeClick={()=>nav("me")} onThemClick={()=>nav("them")} onEditEmoji={()=>{setConnDraft(connEmoji||"💕");setEditConn(true);}} myRole={myRole} theirRole={theirRole}/>
      {editConn&&<div className="overlay" onClick={()=>setEditConn(false)}><div className="sheet" onClick={e=>e.stopPropagation()}><div className="sh-handle"/><h3 className="sh-title">Connection Emoji</h3><input className="field" value={connDraft} onChange={e=>setConnDraft(e.target.value)} maxLength={2} style={{fontSize:32,textAlign:"center",letterSpacing:4,marginBottom:12}}/><button className="btn-p" onClick={()=>{setConnEmoji(connDraft);setEditConn(false);}}>Save</button></div></div>}
    </div>
  );
}

/* ═══════════════════════════════════════════
   ME PAGE
═══════════════════════════════════════════ */
function MePage({myName,theirName,startDate,onSettings,pageName,setPageName,myRole,moodEmojis,setMoodEmojis}){
  const[photo,setPhoto]=useSync("photo_"+myRole,null);
  const[bio,setBio]=useSync("bio_"+myRole,"");
  const[myMood,setMyMood]=useSync("mood_"+myRole,null);
  const[editBio,setEditBio]=useState(false);const[draft,setDraft]=useState(bio);
  const[showSet,setShowSet]=useState(false);const[sN,setSN]=useState(myName);const[sT,setST]=useState(theirName);
  const[editEmojis,setEditEmojis]=useState(false);const[emojiDraft,setEmojiDraft]=useState((moodEmojis||DEF_MOODS).join(" "));
  const fileRef=useRef();
  const handlePhoto=async e=>{
    const f=e.target.files[0];if(!f)return;
    // Compress before syncing — an uncompressed phone photo (several MB as
    // base64) silently fails to write to Firebase with no error surfaced,
    // so it looked like it saved (local state updates instantly) but never
    // actually reached the cloud, which is why it vanished on history clear.
    const b64=await compressImg(f,1080,0.7);
    if(b64)setPhoto(b64);
  };
  const saveBio=()=>{setBio(draft);setEditBio(false);};
  const days=Math.floor((Date.now()-new Date(startDate))/86400000);const e=calcE(startDate);
  return(
    <div className="us-page pf">
      <div className="row-bw"><EditTitle value={pageName} onSave={setPageName}/></div>
      <div style={{textAlign:"center",paddingBottom:14}}>
        <div className="av-wrap">
          <div className="av-ring" onClick={()=>fileRef.current.click()}>{photo?<img src={photo} style={{width:"100%",height:"100%",objectFit:"cover"}} alt="me"/>:<div className="av-ph"><span>👤</span></div>}</div>
          {myMood&&<span className="mood-badge" style={{width:32,height:32,fontSize:18}}>{myMood}</span>}
        </div>
        <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={handlePhoto}/>
        <h2 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"clamp(20px,5.5vw,26px)",fontWeight:600}}>{myName}</h2>
        <p className="cap" style={{marginTop:4}}>in love since {new Date(startDate).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}</p>
      </div>
      <div className="card">
        <div className="card-hdr"><h3 className="card-title">My Mood</h3><button className="edit-pen" title="Edit emoji options" onClick={()=>{setEmojiDraft((moodEmojis||DEF_MOODS).join(" "));setEditEmojis(true);}}><IcPen/></button></div>
        <p className="cap" style={{marginBottom:10}}>Shows as a little badge on your photo, everywhere it appears.</p>
        <div className="mood-row">{(moodEmojis||DEF_MOODS).map(em=><button key={em} className={`mb${myMood===em?" on":""}`} onClick={()=>setMyMood(myMood===em?null:em)}>{em}</button>)}</div>
      </div>
      <div className="card">
        <div className="card-hdr"><h3 className="card-title">About Me</h3><button className="btn-g" onClick={()=>{setEditBio(!editBio);setDraft(bio);}}>{editBio?"Cancel":"Edit"}</button></div>
        {editBio?<><textarea className="field" rows={4} value={draft} onChange={e=>setDraft(e.target.value)} placeholder="Write something…" autoFocus style={{marginBottom:10}}/><button className="btn-p" onClick={saveBio}>Save</button></>:<p style={{fontSize:14,lineHeight:1.75,color:bio?"var(--ink)":"var(--muted)"}}>{bio||"Tap Edit to write a bio…"}</p>}
      </div>
      <div className="card"><h3 className="card-title" style={{marginBottom:12}}>Our Story</h3>
        <div className="stat-grid">{[{v:`${e.mo}mo ${e.dy}d`,l:"Together"},{v:days,l:"Total Days"},{v:Math.floor(days/7),l:"Weeks"},{v:(days*24).toLocaleString(),l:"Hours"}].map(s=><div key={s.l} className="stat-box"><div className="stat-num">{s.v}</div><div className="stat-lbl">{s.l}</div></div>)}</div>
      </div>
      <div className="card">
        <div className="card-hdr"><h3 className="card-title">Profile Settings</h3><button className="btn-g" onClick={()=>setShowSet(!showSet)}>{showSet?"Cancel":"Edit"}</button></div>
        {showSet?<div>
          {[{l:"Your Name",v:sN,s:setSN},{l:"Their Name",v:sT,s:setST}].map(f=><div key={f.l} style={{marginBottom:10}}><div className="lbl" style={{marginBottom:5}}>{f.l}</div><input className="field" value={f.v} onChange={e=>f.s(e.target.value)}/></div>)}
          <button className="btn-p" onClick={()=>{onSettings({myName:sN,theirName:sT,startDate});setShowSet(false);}}>Save</button>
        </div>:<div>{[{l:"Your name",v:myName},{l:"Their name",v:theirName},{l:"Since",v:new Date(startDate).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}].map(r=><div key={r.l} className="srow"><span style={{fontSize:14,fontWeight:500,color:"var(--ink)"}}>{r.l}</span><span className="cap">{r.v}</span></div>)}</div>}
      </div>
      {editEmojis&&<div className="overlay" onClick={()=>setEditEmojis(false)}><div className="sheet" onClick={e=>e.stopPropagation()}><div className="sh-handle"/><h3 className="sh-title">Mood Emoji Options</h3><p className="cap" style={{marginBottom:10}}>Up to 10 emojis, space-separated</p><input className="field" value={emojiDraft} onChange={e=>setEmojiDraft(e.target.value)} style={{fontSize:22,letterSpacing:4,marginBottom:12}}/><button className="btn-p" onClick={()=>{const a=emojiDraft.split(/\s+/).filter(Boolean).slice(0,10);setMoodEmojis(a);setEditEmojis(false);}}>Save</button></div></div>}
    </div>
  );
}

/* ═══════════════════════════════════════════
   PARTNER PROFILE  (read-only view of them)
═══════════════════════════════════════════ */
function PartnerProfilePage({theirName,startDate,theirRole}){
  const[photo]=useSync("photo_"+theirRole,null);
  const[bio]=useSync("bio_"+theirRole,"");
  const[theirMood]=useSync("mood_"+theirRole,null);
  const days=Math.floor((Date.now()-new Date(startDate))/86400000);const e=calcE(startDate);
  return(
    <div className="us-page pf">
      <div style={{textAlign:"center",paddingBottom:14}}>
        <div className="av-wrap">
          <div className="av-ring" style={{cursor:"default"}}>{photo?<img src={photo} style={{width:"100%",height:"100%",objectFit:"cover"}} alt="them"/>:<div className="av-ph"><span>👤</span></div>}</div>
          {theirMood&&<span className="mood-badge" style={{width:32,height:32,fontSize:18}}>{theirMood}</span>}
        </div>
        <h2 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"clamp(20px,5.5vw,26px)",fontWeight:600}}>{theirName}</h2>
        <p className="cap" style={{marginTop:4}}>in love since {new Date(startDate).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}</p>
      </div>
      <div className="card">
        <h3 className="card-title" style={{marginBottom:12}}>About {theirName}</h3>
        <p style={{fontSize:14,lineHeight:1.75,color:bio?"var(--ink)":"var(--muted)"}}>{bio||`${theirName} hasn't written a bio yet.`}</p>
      </div>
      <div className="card"><h3 className="card-title" style={{marginBottom:12}}>Our Story</h3>
        <div className="stat-grid">{[{v:`${e.mo}mo ${e.dy}d`,l:"Together"},{v:days,l:"Total Days"},{v:Math.floor(days/7),l:"Weeks"},{v:(days*24).toLocaleString(),l:"Hours"}].map(s=><div key={s.l} className="stat-box"><div className="stat-num">{s.v}</div><div className="stat-lbl">{s.l}</div></div>)}</div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   FRIDGE PAGE
═══════════════════════════════════════════ */
const VOICE_NOTE_MAX_SEC=90;
function FridgePage({pageName,setPageName,myRole}){
  const[notes,setNotes]=useSync("fridge_notes",[]);
  const[modal,setModal]=useState(false);const[txt,setTxt]=useState("");const[col,setCol]=useState(NOTE_COLS[0]);
  const[editingId,setEditingId]=useState(null);
  const[expandId,setExpandId]=useState(null);
  const[ask,confirmDialog]=useConfirm();
  // Voice recording state
  const[recording,setRecording]=useState(false);
  const[recSecs,setRecSecs]=useState(0);
  const[audioData,setAudioData]=useState(null);
  const[audioSecs,setAudioSecs]=useState(0);
  const[recErr,setRecErr]=useState("");
  const recorderRef=useRef(null);const chunksRef=useRef([]);const timerRef=useRef(null);

  // Strict: only the exact author can edit or delete their own note — never
  // the other account, and never a note stuck before authorship was tracked
  // (there's no way to know who really wrote those, so nobody can touch them).
  const isMine=n=>!!n.author&&n.author===myRole;
  const resetComposer=()=>{setTxt("");setAudioData(null);setAudioSecs(0);setRecErr("");};
  const openNew=()=>{setEditingId(null);resetComposer();setCol(NOTE_COLS[0]);setModal(true);};
  const openEdit=n=>{setEditingId(n.id);setTxt(n.text||"");setCol(n.color);setAudioData(n.audioData||null);setAudioSecs(n.audioSecs||0);setRecErr("");setModal(true);setExpandId(null);};

  const startRecording=async()=>{
    setRecErr("");
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const mr=new MediaRecorder(stream);
      chunksRef.current=[];
      mr.ondataavailable=e=>{if(e.data.size>0)chunksRef.current.push(e.data);};
      mr.onstop=()=>{
        stream.getTracks().forEach(t=>t.stop());
        const blob=new Blob(chunksRef.current,{type:mr.mimeType||"audio/webm"});
        const reader=new FileReader();
        reader.onload=ev=>{setAudioData(ev.target.result);};
        reader.readAsDataURL(blob);
      };
      mr.start();
      recorderRef.current=mr;
      setRecording(true);setRecSecs(0);
      const startedAt=Date.now();
      timerRef.current=setInterval(()=>{
        const s=Math.floor((Date.now()-startedAt)/1000);
        setRecSecs(s);
        if(s>=VOICE_NOTE_MAX_SEC)stopRecording(s);
      },250);
    }catch(e){
      setRecErr("Couldn't access the microphone. Check the site's mic permission and try again.");
    }
  };
  const stopRecording=finalSecs=>{
    if(timerRef.current){clearInterval(timerRef.current);timerRef.current=null;}
    if(recorderRef.current&&recorderRef.current.state!=="inactive")recorderRef.current.stop();
    setRecording(false);
    setAudioSecs(finalSecs??recSecs);
  };
  useEffect(()=>()=>{if(timerRef.current)clearInterval(timerRef.current);},[]);

  const save=()=>{
    if(!txt.trim()&&!audioData)return;
    const payload={text:txt.trim(),color:col,audioData:audioData||null,audioSecs:audioData?audioSecs:0};
    if(editingId)setNotes(notes.map(n=>n.id===editingId?{...n,...payload}:n));
    else setNotes([...notes,{id:Date.now(),...payload,ts:Date.now(),author:myRole}]);
    resetComposer();setModal(false);setEditingId(null);
  };
  const del=id=>ask("Delete this note?",()=>{setNotes(notes.filter(n=>n.id!==id));setExpandId(null);});
  const expanded=notes.find(n=>n.id===expandId);
  return(
    <div className="us-page pf">
      <div className="row-bw"><EditTitle value={pageName} onSave={setPageName}/><button className="btn-i btn-ia" onClick={openNew}><IcPlus/></button></div>
      {notes.length===0?<div className="empty"><div className="empty-e">📋</div><p className="empty-t">Nothing here yet.<br/>Stick a note!</p></div>
        :<div className="fridge-grid">{[...notes].reverse().map(n=>(
          <div key={n.id} className="sticky" style={{background:n.color}} onClick={()=>setExpandId(n.id)}>
            <span className="sticky-badge" style={{background:n.author?ROLE_COLORS[n.author]:"rgba(0,0,0,.28)"}}>{n.author?ROLE_NAMES[n.author]:"Unclaimed"}</span>
            {n.text&&<p className="sticky-txt" style={{marginTop:20}}>{n.text}</p>}
            {n.audioData&&<div style={{marginTop:n.text?8:24,display:"flex",alignItems:"center",gap:6,fontSize:12,fontWeight:600,color:"rgba(0,0,0,.55)"}}>🎤 Voice · {n.audioSecs||0}s</div>}
            <span className="sticky-date">{fmtD(n.ts)}</span>
          </div>
        ))}</div>}

      {/* Read / expand sheet */}
      {expanded&&<div className="overlay" onClick={()=>setExpandId(null)}>
        <div className="sheet" onClick={e=>e.stopPropagation()}>
          <div className="sh-handle"/>
          <div style={{background:expanded.color,borderRadius:14,padding:"16px 16px 14px",marginBottom:12,maxHeight:"45vh",overflowY:"auto",position:"relative"}}>
            <span className="sticky-badge" style={{position:"static",display:"inline-flex",marginBottom:10,background:expanded.author?ROLE_COLORS[expanded.author]:"rgba(0,0,0,.28)"}}>{expanded.author?ROLE_NAMES[expanded.author]:"Unclaimed"}</span>
            {expanded.text&&<p style={{fontSize:14,lineHeight:1.7,color:"#1A1512",whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{expanded.text}</p>}
            {expanded.audioData&&<audio controls src={expanded.audioData} style={{width:"100%",marginTop:expanded.text?12:0,height:36}}/>}
          </div>
          <p className="cap" style={{marginBottom:16}}>{fmtDL(expanded.ts)}</p>
          {isMine(expanded)?(
            <div className="conf-row">
              <button className="btn-p" style={{background:"var(--rose)",color:"var(--ink)"}} onClick={()=>openEdit(expanded)}>✏️ Edit</button>
              <button className="btn-p danger" onClick={()=>del(expanded.id)}>Delete</button>
            </div>
          ):<button className="btn-p" style={{background:"var(--rose)",color:"var(--ink)"}} onClick={()=>setExpandId(null)}>Close</button>}
        </div>
      </div>}

      {/* New / edit sheet */}
      {modal&&<div className="overlay" onClick={()=>{if(recording)stopRecording();setModal(false);}}>
        <div className="sheet" onClick={e=>e.stopPropagation()}>
          <div className="sh-handle"/>
          <h3 className="sh-title">{editingId?"Edit Note":"New Note"}</h3>
          <textarea className="field" rows={4} placeholder="What's on your mind… (optional if you're leaving a voice note)" value={txt} onChange={e=>setTxt(e.target.value)} autoFocus style={{marginBottom:10}}/>

          {audioData?(
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
              <audio controls src={audioData} style={{flex:1,height:36}}/>
              <button onClick={()=>{setAudioData(null);setAudioSecs(0);}} style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",display:"flex",padding:4}}><IcTrash/></button>
            </div>
          ):(
            <button className="btn-sm" style={{width:"100%",padding:"11px",marginBottom:10,borderRadius:12,textAlign:"center",background:recording?"#e05050":"var(--rose)",color:recording?"#fff":"var(--accent)"}} onClick={recording?()=>stopRecording():startRecording}>
              {recording?`⏹ Stop Recording (${recSecs}s / ${VOICE_NOTE_MAX_SEC}s)`:"🎤 Record Voice Note"}
            </button>
          )}
          {recErr&&<p style={{color:"#e05050",fontSize:12,marginBottom:10}}>{recErr}</p>}

          <div className="col-row">{NOTE_COLS.map(c=><button key={c} className={`col-dot${col===c?" sel":""}`} style={{background:c}} onClick={()=>setCol(c)}/>)}</div>
          <button className="btn-p" onClick={save} disabled={!txt.trim()&&!audioData}>{editingId?"Save Changes":"Stick It"}</button>
        </div>
      </div>}
      {confirmDialog}
    </div>
  );
}

/* ═══════════════════════════════════════════
   DATES PAGE  — AI-powered date planner
═══════════════════════════════════════════ */
function DatesPage({pageName,setPageName}){
  const[planned,setPlanned]=useSync("dates_planned",[]);
  const[history,setHistory]=useSync("dates_history",[]);
  const[tab,setTab]=useState("ideas");
  const[ask,confirmDialog]=useConfirm();
  // Planner modal state
  const[plannerIdea,setPlannerIdea]=useState(null);
  const[location,setLocation]=useState("");
  const[searching,setSearching]=useState(false);
  const[results,setResults]=useState([]);
  const[searchErr,setSearchErr]=useState("");
  const[selectedPlace,setSelectedPlace]=useState(null);
  const[planDate,setPlanDate]=useState("");
  const[planNote,setPlanNote]=useState("");

  const openIdea=idea=>{setPlannerIdea(idea);setLocation("");setResults([]);setSearchErr("");setSelectedPlace(null);};
  const closePlanner=()=>{setPlannerIdea(null);setResults([]);setSelectedPlace(null);};

  const doSearch=async()=>{
    if(!location.trim())return;
    setSearching(true);setResults([]);setSearchErr("");
    try{
      const res=await researchPlaces(plannerIdea.n,location);
      if(res.length===0)setSearchErr("No results found. Try a different location or be more specific.");
      setResults(res);
    }catch(e){setSearchErr(e.message||"Search failed. Check your connection and try again.");}
    setSearching(false);
  };

  const confirmPlan=()=>{
    if(!selectedPlace||!planDate)return;
    const entry={id:Date.now(),idea:plannerIdea,place:selectedPlace,location,date:planDate,note:planNote,ts:Date.now(),done:false};
    setPlanned([...planned,entry]);
    setPlannerIdea(null);setResults([]);setSelectedPlace(null);setPlanDate("");setPlanNote("");
  };

  const markDone=id=>{
    const item=planned.find(p=>p.id===id);
    if(item){setHistory([...history,{...item,done:true,done_ts:Date.now()}]);setPlanned(planned.filter(p=>p.id!==id));}
  };

  const delPlanned=id=>ask("Remove this planned date?",()=>setPlanned(planned.filter(p=>p.id!==id)));
  const delHistory=id=>ask("Remove from history?",()=>setHistory(history.filter(h=>h.id!==id)));

  const HalalBadge=({val})=>{
    if(val===true)return<span className="halal-badge halal-yes">✓ Halal</span>;
    if(val===false)return<span className="halal-badge halal-no">✗ Not Halal</span>;
    return<span className="halal-badge halal-unknown">? Unknown</span>;
  };

  const Stars=({rating})=>{
    if(!rating)return null;
    return<span style={{display:"flex",alignItems:"center",gap:3,color:"#f59e0b",fontSize:13}}>{[1,2,3,4,5].map(i=><span key={i} style={{opacity:i<=Math.round(rating)?1:.25}}><IcStar/></span>)}<span style={{color:"var(--muted)",marginLeft:2,fontSize:12}}>{rating}</span></span>;
  };

  return(
    <div className="us-page pf">
      <div className="row-bw"><EditTitle value={pageName} onSave={setPageName}/></div>
      <div className="tab-row">
        <button className={`tab${tab==="ideas"?" on":""}`} onClick={()=>setTab("ideas")}>Ideas</button>
        <button className={`tab${tab==="planned"?" on":""}`} onClick={()=>setTab("planned")}>Planned ({planned.length})</button>
        <button className={`tab${tab==="history"?" on":""}`} onClick={()=>setTab("history")}>History ({history.length})</button>
      </div>

      {tab==="ideas"&&<>
        <p className="cap" style={{marginBottom:12}}>Tap an idea to find real places and plan your date.</p>
        <div className="ideas-grid">{IDEAS_DEF.map(i=>(
          <div key={i.id} className="idea-card" onClick={()=>openIdea(i)}>
            <div style={{fontSize:"clamp(24px,6vw,30px)",marginBottom:6}}>{i.e}</div>
            <div style={{fontSize:12,fontWeight:600,color:"var(--ink)"}}>{i.n}</div>
            <div style={{fontSize:10,color:"var(--muted)",marginTop:3,textTransform:"capitalize"}}>{i.cat}</div>
          </div>
        ))}</div>
      </>}

      {tab==="planned"&&(planned.length===0
        ?<div className="empty"><div className="empty-e">📅</div><p className="empty-t">No dates planned yet.<br/>Tap an idea to plan one!</p></div>
        :<div>{[...planned].sort((a,b)=>new Date(a.date)-new Date(b.date)).map(p=>(
          <div key={p.id} style={{background:"var(--sf)",borderRadius:"var(--r)",padding:"14px",marginBottom:10,boxShadow:"var(--sh)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
              <div><span style={{fontSize:20,marginRight:7}}>{p.idea.e}</span><span style={{fontWeight:600,fontSize:14}}>{p.idea.n}</span></div>
              <div style={{display:"flex",gap:6}}>
                <button className="btn-sm" onClick={()=>markDone(p.id)}>✓ Done</button>
                <button style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",display:"flex"}} onClick={()=>delPlanned(p.id)}><IcTrash/></button>
              </div>
            </div>
            <p style={{fontSize:13,fontWeight:600,color:"var(--ink)",marginBottom:2}}>{p.place.name}</p>
            <p style={{fontSize:12,color:"var(--muted)",marginBottom:4}}>{p.place.address}</p>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
              <span style={{fontSize:12,color:"var(--slate)"}}>📅 {new Date(p.date).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"long"})}</span>
              <HalalBadge val={p.place.isHalal}/>
              {p.place.costTwo&&<span style={{fontSize:12,color:"var(--slate)"}}>💰 {p.place.costTwo} for 2</span>}
            </div>
          </div>
        ))}</div>
      )}

      {tab==="history"&&(history.length===0
        ?<div className="empty"><div className="empty-e">🌟</div><p className="empty-t">No dates completed yet.<br/>Mark planned dates as done!</p></div>
        :<div>
          <div style={{background:"var(--rose)",borderRadius:13,padding:"12px 14px",marginBottom:12,textAlign:"center"}}>
            <span style={{fontFamily:"'Cormorant Garamond',serif",fontSize:22,fontWeight:600,color:"var(--ink)"}}>{history.length}</span>
            <span style={{fontSize:12,color:"var(--slate)",marginLeft:6}}>dates together ✨</span>
          </div>
          {[...history].reverse().map(h=>(
            <div key={h.id} className="date-history-card">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div><span style={{fontSize:18,marginRight:6}}>{h.idea.e}</span><span style={{fontWeight:600,fontSize:14}}>{h.idea.n}</span></div>
                <button style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",display:"flex"}} onClick={()=>delHistory(h.id)}><IcTrash/></button>
              </div>
              <p style={{fontSize:13,color:"var(--slate)",marginTop:4}}>{h.place.name} · {h.location}</p>
              <p style={{fontSize:11,color:"var(--muted)",marginTop:3}}>{fmtDL(h.done_ts||h.ts)} ✅</p>
            </div>
          ))}
        </div>
      )}

      {/* Date Planner Modal */}
      {plannerIdea&&<div className="overlay" onClick={closePlanner}>
        <div className="sheet" onClick={e=>e.stopPropagation()}>
          <div className="sh-handle"/>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
            <span style={{fontSize:28}}>{plannerIdea.e}</span>
            <div><h3 className="sh-title" style={{marginBottom:2}}>{plannerIdea.n}</h3><p className="cap">Where are you thinking?</p></div>
          </div>

          {!selectedPlace?<>
            <div style={{display:"flex",gap:8,marginBottom:10}}>
              <input className="field" style={{flex:1}} placeholder="City or area (e.g. Whitechapel, London)" value={location} onChange={e=>setLocation(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doSearch()} autoFocus/>
              <button className="btn-i btn-ia" onClick={doSearch} style={{flexShrink:0}}><IcSearch/></button>
            </div>

            {searching&&<div className="search-spinner"><div className="spinner"/><p style={{fontSize:13}}>Researching {plannerIdea.n} options in {location}…<br/><span style={{fontSize:11,color:"var(--muted)"}}>Checking halal status, costs & ratings</span></p></div>}
            {searchErr&&<p style={{color:"#e05050",fontSize:13,textAlign:"center",padding:"12px 0"}}>{searchErr}</p>}

            {results.map((pl,i)=>(
              <div key={i} className="place-card">
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                  <div style={{flex:1,minWidth:0}}>
                    <p style={{fontWeight:700,fontSize:15,marginBottom:2}}>{pl.name}</p>
                    <p style={{fontSize:12,color:"var(--muted)",marginBottom:5}}>{pl.address}</p>
                    <Stars rating={pl.rating}/>
                  </div>
                </div>
                <div style={{display:"flex",gap:7,flexWrap:"wrap",margin:"8px 0"}}>
                  <HalalBadge val={pl.isHalal}/>
                  {pl.costOne&&<span style={{fontSize:11,color:"var(--slate)",background:"color-mix(in srgb,var(--ink) 7%,transparent)",padding:"3px 8px",borderRadius:50}}>👤 {pl.costOne}</span>}
                  {pl.costTwo&&<span style={{fontSize:11,color:"var(--slate)",background:"color-mix(in srgb,var(--ink) 7%,transparent)",padding:"3px 8px",borderRadius:50}}>👥 {pl.costTwo}</span>}
                </div>
                {pl.halalQuote&&<div className="place-quote">"{pl.halalQuote}"<br/><span style={{fontSize:10,opacity:.7}}>Source: {pl.halalSource}</span></div>}
                {pl.description&&<p style={{fontSize:13,color:"var(--slate)",marginBottom:10}}>{pl.description}</p>}
                {pl.website&&<a href={pl.website} target="_blank" rel="noopener noreferrer" style={{fontSize:12,color:"var(--accent)",display:"block",marginBottom:10,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} onClick={e=>e.stopPropagation()}>🔗 {pl.website.replace(/^https?:\/\//,"")}</a>}
                <button className="btn-p" onClick={()=>setSelectedPlace(pl)}>Plan This Date →</button>
              </div>
            ))}
          </>:<>
            <div style={{background:"var(--rose)",borderRadius:13,padding:"12px 14px",marginBottom:14}}>
              <p style={{fontWeight:600,fontSize:14}}>{selectedPlace.name}</p>
              <p style={{fontSize:12,color:"var(--slate)",marginTop:2}}>{selectedPlace.address}</p>
              <button style={{background:"none",border:"none",cursor:"pointer",color:"var(--accent)",fontSize:12,marginTop:6}} onClick={()=>setSelectedPlace(null)}>← Choose different place</button>
            </div>
            <div className="lbl" style={{marginBottom:5}}>Date</div>
            <input className="field" type="date" value={planDate} onChange={e=>setPlanDate(e.target.value)} style={{marginBottom:10}}/>
            <div className="lbl" style={{marginBottom:5}}>Note (optional)</div>
            <input className="field" placeholder="Any details…" value={planNote} onChange={e=>setPlanNote(e.target.value)} style={{marginBottom:14}}/>
            <button className="btn-p" onClick={confirmPlan} disabled={!planDate}>Confirm Date Plan</button>
          </>}
        </div>
      </div>}
      {confirmDialog}
    </div>
  );
}

/* ═══════════════════════════════════════════
   MAP PAGE
═══════════════════════════════════════════ */
function avatarDivIcon(photo,emoji,color,size=36){
  return L.divIcon({
    className:"",
    html:`<div style="width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;box-shadow:0 0 0 3px ${color},0 3px 10px rgba(0,0,0,.45);background:${photo?"#fff":color};display:flex;align-items:center;justify-content:center;font-size:${size*0.5}px;">${photo?`<img src="${photo}" style="width:100%;height:100%;object-fit:cover;display:block"/>`:emoji}</div>`,
    iconSize:[size,size],
    iconAnchor:[size/2,size/2],
  });
}
function memoryDivIcon(selected){
  const s=selected?18:13;
  return L.divIcon({
    className:"",
    html:`<div style="width:${s}px;height:${s}px;border-radius:50%;background:${selected?"var(--accent,#C45450)":"#fff"};box-shadow:0 0 0 2px ${selected?"#fff":"var(--accent,#C45450)"},0 2px 6px rgba(0,0,0,.4)"></div>`,
    iconSize:[s,s],
    iconAnchor:[s/2,s/2],
  });
}

/* Real interactive satellite map (Leaflet + free Esri World Imagery tiles —
   no API key). Markers/line update in place rather than re-creating the map
   on every render, so panning/zooming stays smooth. */
function LeafletMap({myLoc,theirLoc,myRole,theirRole,myPhoto,theirPhoto,memories,selId,onSelectMemory,view}){
  const elRef=useRef(null);
  const mapRef=useRef(null);
  const layersRef=useRef({me:null,them:null,line:null,distLabel:null,mem:new Map()});

  useEffect(()=>{
    if(!elRef.current||mapRef.current)return;
    const map=L.map(elRef.current,{zoomControl:true,attributionControl:true});
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{
      maxZoom:19,
      attribution:"Tiles &copy; Esri",
    }).addTo(map);
    map.setView([20,0],2);
    mapRef.current=map;
    return()=>{map.remove();mapRef.current=null;};
  },[]);

  // Markers + connecting line + distance label
  useEffect(()=>{
    const map=mapRef.current;
    if(!map)return;
    const L_=layersRef.current;

    if(myLoc){
      const ll=[myLoc.lat,myLoc.lon];
      if(!L_.me){L_.me=L.marker(ll,{icon:avatarDivIcon(myPhoto,"🙋",ROLE_COLORS[myRole]||"#3D6FD6")}).addTo(map);}
      else{L_.me.setLatLng(ll);L_.me.setIcon(avatarDivIcon(myPhoto,"🙋",ROLE_COLORS[myRole]||"#3D6FD6"));}
    }else if(L_.me){L_.me.remove();L_.me=null;}

    if(theirLoc){
      const ll=[theirLoc.lat,theirLoc.lon];
      if(!L_.them){L_.them=L.marker(ll,{icon:avatarDivIcon(theirPhoto,"💁",ROLE_COLORS[theirRole]||"#D6407D")}).addTo(map);}
      else{L_.them.setLatLng(ll);L_.them.setIcon(avatarDivIcon(theirPhoto,"💁",ROLE_COLORS[theirRole]||"#D6407D"));}
    }else if(L_.them){L_.them.remove();L_.them=null;}

    if(myLoc&&theirLoc){
      const a=[myLoc.lat,myLoc.lon],b=[theirLoc.lat,theirLoc.lon];
      if(!L_.line)L_.line=L.polyline([a,b],{color:"#fff",weight:2,opacity:.85,dashArray:"6,8"}).addTo(map);
      else L_.line.setLatLngs([a,b]);
      const mid=[(a[0]+b[0])/2,(a[1]+b[1])/2];
      const distTxt=fmtDist(hav(a[0],a[1],b[0],b[1]));
      const distIcon=L.divIcon({className:"",html:`<div style="background:rgba(0,0,0,.72);color:#fff;font-size:11px;font-weight:700;padding:4px 9px;border-radius:50px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.3)">${distTxt} apart</div>`,iconSize:[0,0]});
      if(!L_.distLabel)L_.distLabel=L.marker(mid,{icon:distIcon,interactive:false}).addTo(map);
      else{L_.distLabel.setLatLng(mid);L_.distLabel.setIcon(distIcon);}
    }else{
      if(L_.line){L_.line.remove();L_.line=null;}
      if(L_.distLabel){L_.distLabel.remove();L_.distLabel=null;}
    }

    // Memory pins — rebuilt each time; personal-app scale, not a perf concern
    L_.mem.forEach(mk=>mk.remove());
    L_.mem.clear();
    memories.forEach(m=>{
      const mk=L.marker([m.lat,m.lon],{icon:memoryDivIcon(m.id===selId)});
      mk.on("click",()=>onSelectMemory(m.id));
      mk.bindTooltip(m.note,{direction:"top",offset:[0,-8]});
      mk.addTo(map);
      L_.mem.set(m.id,mk);
    });
  },[myLoc,theirLoc,myRole,theirRole,myPhoto,theirPhoto,memories,selId,onSelectMemory]);

  // Camera — reacts to the view toggle and to a selected memory
  useEffect(()=>{
    const map=mapRef.current;
    if(!map)return;
    const selected=memories.find(m=>m.id===selId);
    if(selected){map.flyTo([selected.lat,selected.lon],15,{duration:.6});return;}
    if(view==="me"&&myLoc){map.flyTo([myLoc.lat,myLoc.lon],14,{duration:.6});return;}
    if(view==="them"&&theirLoc){map.flyTo([theirLoc.lat,theirLoc.lon],14,{duration:.6});return;}
    // "both" (or fallback): fit everything we have, zoomed out enough to show the connecting line
    const pts=[];
    if(myLoc)pts.push([myLoc.lat,myLoc.lon]);
    if(theirLoc)pts.push([theirLoc.lat,theirLoc.lon]);
    if(pts.length===2)map.flyToBounds(pts,{padding:[60,60],duration:.6});
    else if(pts.length===1)map.flyTo(pts[0],13,{duration:.6});
    else if(memories.length)map.flyTo([memories[memories.length-1].lat,memories[memories.length-1].lon],12,{duration:.6});
  },[view,selId,myLoc,theirLoc,memories]);

  return <div ref={elRef} className="map-frame" style={{background:"#0a1420"}}/>;
}

function MapPage({pageName,setPageName,myRole,theirRole,myName,theirName}){
  const[memories,setMemories]=useSync("map_memories",[]);
  const[myLoc,setMyLoc]=useSync("loc_"+myRole,null);
  const[theirLoc]=useSync("loc_"+theirRole,null);
  const[myPhoto]=useSync("photo_"+myRole,null);
  const[theirPhoto]=useSync("photo_"+theirRole,null);
  const[selId,setSelId]=useState(null);
  const[view,setView]=useState("both"); // "both" | "me" | "them" — cleared when a memory is selected
  const[adding,setAdding]=useState(false);
  const[pending,setPending]=useState(null);const[noteText,setNoteText]=useState("");
  const[gettingLoc,setGettingLoc]=useState(false);
  const[ask,confirmDialog]=useConfirm();
  const dist=myLoc&&theirLoc?hav(myLoc.lat,myLoc.lon,theirLoc.lat,theirLoc.lon):null;
  const pct=dist!=null?Math.max(4,Math.min(96,100-dist/5)):null;

  const saveMemory=()=>{if(!pending)return;const m={id:Date.now(),lat:pending.lat,lon:pending.lon,note:noteText.trim()||"Memory",ts:Date.now()};setMemories([...memories,m]);setSelId(m.id);setNoteText("");setPending(null);setAdding(false);};
  const delMemory=id=>ask("Delete this memory pin?",()=>{setMemories(memories.filter(m=>m.id!==id));if(selId===id)setSelId(null);});
  const findMe=()=>{
    if(!navigator.geolocation){alert("Geolocation not supported.");return;}
    setGettingLoc(true);
    navigator.geolocation.getCurrentPosition(p=>{setMyLoc({lat:p.coords.latitude,lon:p.coords.longitude,ts:Date.now()});setGettingLoc(false);setSelId(null);setView("me");},
      ()=>{setGettingLoc(false);alert("Location access denied.\n\nTo fix: tap the lock icon in your browser address bar → Site Settings → Location → Allow, then try again.");},
      {enableHighAccuracy:true,timeout:12000});
  };
  const Avatar=({photo,emoji,size=30})=>(
    <div style={{width:size,height:size,borderRadius:"50%",overflow:"hidden",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",background:photo?"transparent":"linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 75%,#f99))",boxShadow:"0 0 0 2px var(--sf)"}}>
      {photo?<img src={photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<span style={{fontSize:size*0.5,color:"#fff"}}>{emoji}</span>}
    </div>
  );
  return(
    <div className="us-page pf">
      <div className="row-bw"><EditTitle value={pageName} onSave={setPageName}/></div>

      {/* Distance hero */}
      <div className="ctr-card" style={{padding:"16px 18px",marginBottom:10}}>
        <div style={{display:"flex",alignItems:"center",gap:12,position:"relative",zIndex:1}}>
          <Avatar photo={myPhoto} emoji="🙋" size={38}/>
          <div style={{flex:1,minWidth:0}}>
            <div className="dist-bar" style={{margin:"0 0 4px"}}>
              {pct!=null&&<div className="dist-fill" style={{width:`${pct}%`}}/>}
            </div>
            <div style={{textAlign:"center",fontFamily:"'Cormorant Garamond',serif",fontSize:"clamp(15px,4.5vw,19px)",fontWeight:700,color:"var(--ink)"}}>
              {dist!=null?fmtDist(dist):myLoc&&!theirLoc?`Waiting on ${theirName}…`:!myLoc&&theirLoc?"Share your location":"Distance unknown"}
            </div>
          </div>
          <Avatar photo={theirPhoto} emoji="💁" size={38}/>
        </div>
        {myLoc&&theirLoc&&<p style={{position:"relative",zIndex:1,textAlign:"center",fontSize:10,color:"var(--ink)",opacity:.6,marginTop:8,fontWeight:600,letterSpacing:".04em"}}>YOU {ago(myLoc.ts)} · {theirName.toUpperCase()} {ago(theirLoc.ts)}</p>}
      </div>

      {/* Segmented view control */}
      <div style={{display:"flex",gap:6,marginBottom:10}}>
        {[{k:"both",l:"🔗 Both"},{k:"me",l:"🙋 "+myName},{k:"them",l:"💁 "+theirName}].map(t=>(
          <button key={t.k} className={`btn-sm${view===t.k&&!selId?" on":""}`} style={{flex:1,textAlign:"center"}} onClick={()=>{setView(t.k);setSelId(null);}}>{t.l}</button>
        ))}
        <button className={`btn-i${gettingLoc?" btn-ia":""}`} style={{width:38,height:38,flexShrink:0}} onClick={findMe} title="Update my location">
          {gettingLoc?<div className="spinner" style={{width:16,height:16,borderWidth:2}}/>:<IcPin/>}
        </button>
        <button className={`btn-i${adding?" btn-ia":""}`} style={{width:38,height:38,flexShrink:0}} onClick={()=>setAdding(!adding)} title="Pin a memory">
          {adding?<IcX/>:<IcPlus/>}
        </button>
      </div>

      {adding&&<div style={{background:"var(--deep)",borderRadius:10,padding:"8px 12px",marginBottom:9,fontSize:13,display:"flex",gap:7,justifyContent:"center"}}>
        <button style={{background:"var(--accent)",color:"#fff",border:"none",borderRadius:8,padding:"5px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}} onClick={()=>{setGettingLoc(true);navigator.geolocation?.getCurrentPosition(p=>{setPending({lat:p.coords.latitude,lon:p.coords.longitude});setGettingLoc(false);setAdding(false);},()=>{setPending({lat:51.505,lon:-0.09});setGettingLoc(false);},{enableHighAccuracy:true,timeout:10000});}}>📍 Use GPS</button>
        <button style={{background:"color-mix(in srgb,var(--accent) 12%,transparent)",color:"var(--accent)",border:"none",borderRadius:8,padding:"5px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}} onClick={()=>{setPending({lat:51.505,lon:-0.09});setAdding(false);}}>✏️ Enter Coords</button>
      </div>}

      {/* Real satellite map — both pins, a connecting line + distance when you have both, zooms out to fit on "Both" */}
      <div style={{position:"relative",marginBottom:8,borderRadius:"var(--r)",overflow:"hidden",boxShadow:"var(--sh-md)"}}>
        <LeafletMap myLoc={myLoc} theirLoc={theirLoc} myRole={myRole} theirRole={theirRole} myPhoto={myPhoto} theirPhoto={theirPhoto}
          memories={memories} selId={selId} onSelectMemory={id=>setSelId(selId===id?null:id)} view={view}/>
      </div>

      {memories.length===0?<div className="empty" style={{padding:"22px 20px"}}><div className="empty-e">📍</div><p className="empty-t">No memories pinned yet.<br/>Tap + above to drop your first one.</p></div>
        :<div>{[...memories].reverse().map(m=><div key={m.id} className={`mem-card${selId===m.id?" sel":""}`} onClick={()=>{setSelId(selId===m.id?null:m.id);}}>
          <div className="mem-dot"><IcPin/></div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:600,fontSize:14,marginBottom:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.note}</div>
            <div className="cap">{fmtDL(m.ts)}{myLoc?` · ${fmtDist(hav(myLoc.lat,myLoc.lon,m.lat,m.lon))} from you`:""}</div>
          </div>
          <button onClick={e=>{e.stopPropagation();delMemory(m.id);}} style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",display:"flex",padding:3}}><IcTrash/></button>
        </div>)}</div>}
      {pending&&<div className="overlay" onClick={()=>setPending(null)}><div className="sheet" onClick={e=>e.stopPropagation()}>
        <div className="sh-handle"/><h3 className="sh-title">📍 New Memory Pin</h3>
        <div style={{display:"flex",gap:8,marginBottom:10}}>
          <div style={{flex:1}}><div className="lbl" style={{marginBottom:4}}>Latitude</div><input className="field" type="number" step="0.0001" value={pending.lat} onChange={e=>setPending(p=>({...p,lat:parseFloat(e.target.value)||0}))}/></div>
          <div style={{flex:1}}><div className="lbl" style={{marginBottom:4}}>Longitude</div><input className="field" type="number" step="0.0001" value={pending.lon} onChange={e=>setPending(p=>({...p,lon:parseFloat(e.target.value)||0}))}/></div>
        </div>
        <div className="lbl" style={{marginBottom:5}}>Note</div>
        <textarea className="field" rows={3} placeholder="What's special here…" value={noteText} onChange={e=>setNoteText(e.target.value)} autoFocus style={{marginBottom:12}}/>
        <button className="btn-p" onClick={saveMemory}>Save Memory</button>
      </div></div>}
      {confirmDialog}
    </div>
  );
}

/* ═══════════════════════════════════════════
   GALLERY PAGE
═══════════════════════════════════════════ */
function GalleryPage({pageName,setPageName,myName}){
  const[storedPin]=useSync("gal_pin","69420");
  const[unlocked,setUnlocked]=useState(false);
  const[inp,setInp]=useState("");const[pinErr,setPinErr]=useState(false);
  const[cats,setCats]=useSync("gal_cats",DEF_CATS);
  const[photos,setPhotos]=useSync("gal_photos",[]);
  const[selCat,setSelCat]=useState("all");
  const[lightbox,setLightbox]=useState(null);
  const[addCatM,setAddCatM]=useState(false);
  const[newCatLabel,setNewCatLabel]=useState("");const[newCatEmoji,setNewCatEmoji]=useState("📸");
  const[uploading,setUploading]=useState(false);
  const[ask,confirmDialog]=useConfirm();
  const fileRef=useRef();

  const press=k=>{
    if(inp.length>=5)return;const next=inp+k;setInp(next);
    if(next.length===5){setTimeout(()=>{if(next===storedPin){setUnlocked(true);setInp("");}else{setPinErr(true);setTimeout(()=>{setInp("");setPinErr(false);},650);}},180);}
  };

  const filtered=selCat==="all"?photos:photos.filter(p=>p.catId===selCat);

  const handleUpload=async e=>{
    setUploading(true);
    const files=Array.from(e.target.files);
    const newItems=[];
    for(const f of files){
      if(f.type.startsWith("image/")){
        const b64=await compressImg(f,1080,0.65);
        if(b64)newItems.push({id:Date.now()+Math.random(),type:"photo",src:b64,catId:selCat==="all"?"together":selCat,ts:Date.now(),uploader:myName||"Me"});
      }else if(f.type.startsWith("video/")){
        if(f.size>80*1024*1024){alert(`"${f.name}" is too large (max 80MB). Trim it first.`);continue;}
        newItems.push({id:Date.now()+Math.random(),type:"video",src:URL.createObjectURL(f),local:true,catId:selCat==="all"?"together":selCat,ts:Date.now(),uploader:myName||"Me",name:f.name});
      }
    }
    setPhotos([...photos,...newItems]);setUploading(false);
  };

  const delItem=id=>ask("Delete this photo/video?",()=>{setPhotos(photos.filter(p=>p.id!==id));if(lightbox&&lightbox.id===id)setLightbox(null);});
  const addCat=()=>{if(!newCatLabel.trim())return;setCats([...cats,{id:"c_"+Date.now(),label:newCatEmoji+" "+newCatLabel.trim()}]);setNewCatLabel("");setAddCatM(false);};
  const delCat=id=>{if(DEF_CATS.find(c=>c.id===id)){alert("Can't delete a default category.");return;}ask("Delete this category?",()=>{setCats(cats.filter(c=>c.id!==id));if(selCat===id)setSelCat("all");});};

  if(!unlocked)return(
    <div className="us-page pf">
      <div className="pin-wrap">
        <h2 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"clamp(22px,6vw,26px)",fontWeight:600,marginBottom:6}}>Gallery</h2>
        <p className="cap" style={{marginBottom:26,textAlign:"center"}}>Enter PIN to open</p>
        <div className="pin-dots">{[0,1,2,3,4].map(i=><div key={i} className={`pin-dot${i<inp.length?" filled":""}${pinErr?" err":""}`}/>)}</div>
        <div className="pin-pad">{[1,2,3,4,5,6,7,8,9].map(n=><button key={n} className="pin-key" onClick={()=>press(String(n))}>{n}</button>)}<div/><button className="pin-key" onClick={()=>press("0")}>0</button><button className="pin-key" style={{fontFamily:"Inter",fontSize:20}} onClick={()=>setInp(p=>p.slice(0,-1))}>⌫</button></div>
      </div>
    </div>
  );

  return(
    <div className="us-page pf">
      <div className="row-bw">
        <EditTitle value={pageName} onSave={setPageName}/>
        <div style={{display:"flex",gap:7}}>
          <button className="btn-i" style={{fontSize:14}} onClick={()=>setAddCatM(true)}>+</button>
          <button className="btn-i btn-ia" onClick={()=>fileRef.current.click()}>{uploading?"…":<IcCam/>}</button>
          <button className="btn-i" style={{fontSize:15}} onClick={()=>setUnlocked(false)}>🔒</button>
        </div>
      </div>
      <input ref={fileRef} type="file" accept="image/*,video/*" multiple style={{display:"none"}} onChange={handleUpload}/>
      <div className="tab-row">
        <button className={`tab${selCat==="all"?" on":""}`} onClick={()=>setSelCat("all")}>All ({photos.length})</button>
        {cats.map(c=><button key={c.id} className={`tab${selCat===c.id?" on":""}`} style={{display:"flex",alignItems:"center",gap:4}} onClick={()=>setSelCat(c.id)}>
          {c.label}
          {!DEF_CATS.find(d=>d.id===c.id)&&<span style={{opacity:.5,fontSize:10,marginLeft:2}} onClick={e=>{e.stopPropagation();delCat(c.id);}}>✕</span>}
        </button>)}
      </div>
      {filtered.length===0?<div className="empty"><div className="empty-e">📸</div><p className="empty-t">No photos here yet.</p></div>
        :<div className="photo-grid">{filtered.map(p=><div key={p.id} className="photo-cell" onClick={()=>setLightbox(p)}>
          {p.type==="video"?<><video src={p.src} style={{width:"100%",height:"100%",objectFit:"cover"}}/><span style={{position:"absolute",top:4,left:4,background:"rgba(0,0,0,.55)",color:"#fff",fontSize:9,fontWeight:700,padding:"2px 5px",borderRadius:4}}>VIDEO</span></>:<img src={p.src} alt=""/>}
          {p.local&&<span style={{position:"absolute",bottom:2,right:2,background:"rgba(0,0,0,.5)",color:"#fff",fontSize:8,padding:"1px 4px",borderRadius:3}}>LOCAL</span>}
        </div>)}</div>}
      {addCatM&&<div className="overlay" onClick={()=>setAddCatM(false)}><div className="sheet" onClick={e=>e.stopPropagation()}>
        <div className="sh-handle"/><h3 className="sh-title">New Category</h3>
        <div style={{display:"flex",gap:8,marginBottom:12}}><input className="field" style={{width:52,textAlign:"center",fontSize:20,flexShrink:0,padding:"9px 4px"}} value={newCatEmoji} onChange={e=>setNewCatEmoji(e.target.value)} maxLength={2}/><input className="field" placeholder="Category name…" value={newCatLabel} onChange={e=>setNewCatLabel(e.target.value)} autoFocus/></div>
        <button className="btn-p" onClick={addCat}>Add</button>
      </div></div>}
      {lightbox&&<div className="lb-overlay" onClick={()=>setLightbox(null)}>
        <div style={{maxWidth:440,width:"100%",borderRadius:18,overflow:"hidden",background:"#111",position:"relative"}} onClick={e=>e.stopPropagation()}>
          {lightbox.type==="video"?<video src={lightbox.src} controls style={{width:"100%",maxHeight:"60vh",display:"block"}}/>:<img src={lightbox.src} style={{width:"100%",display:"block",maxHeight:"60vh",objectFit:"contain"}} alt=""/>}
          <div style={{padding:"10px 14px",background:"rgba(0,0,0,.55)"}}><div style={{fontSize:12,color:"rgba(255,255,255,.7)"}}>{cats.find(c=>c.id===lightbox.catId)?.label||""} · {lightbox.uploader} · {fmtD(lightbox.ts)}</div></div>
          <div style={{display:"flex",justifyContent:"space-between",padding:"10px 14px",background:"rgba(0,0,0,.7)"}}>
            <button style={{color:"#fff",background:"rgba(255,255,255,.18)",border:"none",borderRadius:8,padding:"7px 16px",fontSize:13,fontWeight:600,cursor:"pointer"}} onClick={()=>setLightbox(null)}>Close</button>
            <button style={{color:"#fff",background:"rgba(200,50,50,.65)",border:"none",borderRadius:8,padding:"7px 16px",fontSize:13,fontWeight:600,cursor:"pointer"}} onClick={()=>delItem(lightbox.id)}>Delete</button>
          </div>
        </div>
      </div>}
      {confirmDialog}
    </div>
  );
}

/* ═══════════════════════════════════════════
   PRIVATE NOTES
═══════════════════════════════════════════ */
function NotesPage({pageName,setPageName}){
  const[unlocked,setUnlocked]=useState(false);
  const[inp,setInp]=useState("");const[pinErr,setPinErr]=useState(false);
  const[notes,setNotes]=useState(()=>gs("my_private_notes",[]));
  const[modal,setModal]=useState(false);const[draft,setDraft]=useState("");const[expand,setExpand]=useState(null);
  const[ask,confirmDialog]=useConfirm();
  const press=k=>{if(inp.length>=5)return;const next=inp+k;setInp(next);if(next.length===5){setTimeout(()=>{if(next===gs("notes_pin","69420")){setUnlocked(true);setInp("");}else{setPinErr(true);setTimeout(()=>{setInp("");setPinErr(false);},650);}},180);}};
  const addNote=()=>{if(!draft.trim())return;const n=[...notes,{id:Date.now(),text:draft.trim(),ts:Date.now()}];setNotes(n);ss("my_private_notes",n);setDraft("");setModal(false);};
  const delNote=id=>ask("Delete this note? This cannot be undone.",()=>{const n=notes.filter(n=>n.id!==id);setNotes(n);ss("my_private_notes",n);});
  if(!unlocked)return(
    <div className="us-page pf">
      <div className="pin-wrap">
        <div style={{fontSize:"clamp(32px,8vw,40px)",marginBottom:14}}>🔒</div>
        <h2 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"clamp(20px,5.5vw,24px)",fontWeight:600,marginBottom:6}}>Private Notes</h2>
        <div className="priv-banner" style={{maxWidth:290,marginBottom:22}}>These notes are <strong>only visible to you.</strong><br/>They are never shared, synced, or seen by your partner — ever.</div>
        <div className="pin-dots">{[0,1,2,3,4].map(i=><div key={i} className={`pin-dot${i<inp.length?" filled":""}${pinErr?" err":""}`}/>)}</div>
        <div className="pin-pad">{[1,2,3,4,5,6,7,8,9].map(n=><button key={n} className="pin-key" onClick={()=>press(String(n))}>{n}</button>)}<div/><button className="pin-key" onClick={()=>press("0")}>0</button><button className="pin-key" style={{fontFamily:"Inter",fontSize:20}} onClick={()=>setInp(p=>p.slice(0,-1))}>⌫</button></div>
      </div>
    </div>
  );
  return(
    <div className="us-page pf">
      <div className="row-bw">
        <EditTitle value={pageName} onSave={setPageName}/>
        <div style={{display:"flex",gap:7}}>
          <button className="btn-i btn-ia" onClick={()=>setModal(true)}><IcPlus/></button>
          <button className="btn-i" style={{fontSize:15}} onClick={()=>setUnlocked(false)}>🔒</button>
        </div>
      </div>
      <div className="priv-banner">🔒 Only you can see these. Your partner cannot access them.</div>
      {notes.length===0?<div className="empty"><div className="empty-e">📝</div><p className="empty-t">Nothing here yet.<br/>Write something just for you.</p></div>
        :<div>{[...notes].reverse().map(n=><div key={n.id} className="card" style={{cursor:"pointer"}} onClick={()=>setExpand(expand===n.id?null:n.id)}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:expand===n.id?8:0,alignItems:"flex-start"}}>
            <span style={{fontSize:11,color:"var(--muted)",fontWeight:500}}>{fmtFull(n.ts)}</span>
            <button onClick={e=>{e.stopPropagation();delNote(n.id);}} style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",display:"flex",padding:2}}><IcTrash/></button>
          </div>
          {expand===n.id?<p style={{fontSize:14,lineHeight:1.75,color:"var(--ink)"}}>{n.text}</p>:<p style={{fontSize:14,color:"var(--slate)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{n.text}</p>}
        </div>)}</div>}
      {modal&&<div className="overlay" onClick={()=>setModal(false)}><div className="sheet" onClick={e=>e.stopPropagation()}>
        <div className="sh-handle"/><h3 className="sh-title">New Private Note</h3>
        <p className="cap" style={{marginBottom:10}}>{fmtFull(Date.now())} · Only you will see this</p>
        <textarea className="field" rows={7} placeholder="Write your private thoughts…" value={draft} onChange={e=>setDraft(e.target.value)} autoFocus style={{marginBottom:12}}/>
        <button className="btn-p" onClick={addNote}>Save Note</button>
      </div></div>}
      {confirmDialog}
    </div>
  );
}

/* ═══════════════════════════════════════════
   SETTINGS PAGE
═══════════════════════════════════════════ */
function SettingsPage({pageName,setPageName,theme,setTheme,bgImage,setBgImage,names,setNames,
  myName,theirName,startDate,onSettings,fbApiKey,setFbApiKey,fbDbUrl,setFbDbUrl,synced,
  onReplayIntro,onTestMusic,musicPlaying,stopMusic}){

  const[bgDraft,setBgDraft]=useState(bgImage||"");
  const[sheet,setSheet]=useState(null); // which settings sheet is open, if any
  const closeSheet=()=>setSheet(null);

// Intro music — enabled independently per account
  const [musicEnabledUth, setMusicEnabledUth] = useState(() => gs("music_enabled_uthmaan", false));
  const [musicEnabledAreebah, setMusicEnabledAreebah] = useState(() => gs("music_enabled_areebah", false));
  const [musicHasFile, setMusicHasFile] = useState(() => !!gs("music_file_b64", null));
  const [musicFileName, setMusicFileName] = useState(() => gs("music_file_name", ""));
  useEffect(()=>{
    if(!gs("music_file_b64",null)){
        dbGet("room/music_file_b64").then(v=>{
            if(v){ss("music_file_b64",v);setMusicHasFile(true);}
        });
        dbGet("room/music_file_name").then(v=>{
            if(v){ss("music_file_name",v);setMusicFileName(v);}
        });
    }
},[]);
  const [spotifyUrl, setSpotifyUrl] = useState(() => gs("music_spotify_url", ""));
  const [musicMsg, setMusicMsg] = useState("");
  const musicFileRef = useRef();

  const toggleMusicFor = (role, v) => {
    if(role==="uthmaan")setMusicEnabledUth(v); else setMusicEnabledAreebah(v);
    ss(`music_enabled_${role}`, v);
    dbWrite(`room/music_enabled_${role}`, v);
  };

  const handleMusicUpload = e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 8 * 1024 * 1024) { 
      alert("File too large. Max 8MB.");
      return; 
    }
    const r = new FileReader();
    r.onload = ev => {
      const b64Data = ev.target.result;
      
      // 1. Save locally
      ss("music_file_b64", b64Data);
      ss("music_file_name", f.name);
      
      dbWrite("room/music_file_b64", ev.target.result);
      dbWrite("room/music_file_name", f.name);

      setMusicMsg("Uploading to Cloud...");

      // 2. Save to Firebase and explicitly catch any errors
      Promise.all([
        dbWrite("room/music_file_b64", b64Data),
        dbWrite("room/music_file_name", f.name)
      ])
      .then(() => {
        setMusicHasFile(true);
        setMusicFileName(f.name);
        setMusicMsg("Uploaded & saved to Cloud: " + f.name);
        alert("Success! Saved to Cloud.");
      })
      .catch(err => {
        // This will pop up a window on your phone showing the exact database error
        alert("Firebase Error: " + err.message);
        setMusicMsg("Cloud save failed: " + err.message);
      });
    };
    r.readAsDataURL(f);
  };

  const clearMusicFile = () => {
    // 1. Clear locally
    ss("music_file_b64", null);
    ss("music_file_name", "");
    
    // 2. Clear from Cloud
    try {
      dbWrite("room/music_file_b64", null);
      dbWrite("room/music_file_name", null);
    } catch {}

    setMusicHasFile(false);
    setMusicFileName("");
    setMusicMsg("Removed.");
  };
  
// Pull the music file from the cloud automatically once logged in
  useEffect(() => {
    // 1. If we don't have an active login session, wait.
    const auth = gs("auth_user", null);
    if (!auth) return;

    let unsubB64 = null;
    let unsubName = null;
    let unsubUth = null;
    let unsubAreebah = null;

    // 2. Introduce a 1-second delay to let Firebase Auth resolve
    // and prevent premature unauthorized REST requests.
    const delayTimer = setTimeout(() => {
      try {
        // Only fetch if we are actually missing the local cache
        if (!gs("music_file_b64", null)) {
          unsubB64 = dbListen("room/music_file_b64", v => {
            if (v) {
              ss("music_file_b64", v);
              setMusicHasFile(true);
            }
          });
        }

        if (!gs("music_file_name", "")) {
          unsubName = dbListen("room/music_file_name", v => {
            if (v) {
              ss("music_file_name", v);
              setMusicFileName(v);
            }
          });
        }

        // Keep both accounts' enable toggles in sync with the cloud —
        // either partner can flip the other's switch from this same screen.
        unsubUth = dbListen("room/music_enabled_uthmaan", v => {
          ss("music_enabled_uthmaan", !!v);
          setMusicEnabledUth(!!v);
        });
        unsubAreebah = dbListen("room/music_enabled_areebah", v => {
          ss("music_enabled_areebah", !!v);
          setMusicEnabledAreebah(!!v);
        });
      } catch (e) {
        console.log("Database fetch failed on startup:", e.message);
      }
    }, 1000);

    return () => {
      clearTimeout(delayTimer);
      if (typeof unsubB64 === 'function') unsubB64();
      if (typeof unsubName === 'function') unsubName();
      if (typeof unsubUth === 'function') unsubUth();
      if (typeof unsubAreebah === 'function') unsubAreebah();
    };
  }, [synced]);

  const saveSpotify=()=>{ss("music_spotify_url",spotifyUrl);dbWrite("room/music_spotify_url",spotifyUrl);setMusicMsg("Spotify URL saved.");};
  const[nameDraft,setNameDraft]=useState({...names});
  const[sN,setSN]=useState(myName);
  const[sT,setST]=useState(theirName);

  // Change PINs
  const[,setGalPin]=useSync("gal_pin","69420");
  const[galDraft,setGalDraft]=useState("");
  const[notesDraft,setNotesDraft]=useState("");
  const[pinMsg,setPinMsg]=useState("");
  const savePins=()=>{
    if(galDraft&&(galDraft.length!==5||!/^\d{5}$/.test(galDraft))){setPinMsg("Gallery PIN must be exactly 5 digits.");return;}
    if(notesDraft&&(notesDraft.length!==5||!/^\d{5}$/.test(notesDraft))){setPinMsg("Notes PIN must be exactly 5 digits.");return;}
    if(galDraft){setGalPin(galDraft);setGalDraft("");}
    if(notesDraft){ss("notes_pin",notesDraft);setNotesDraft("");}
    setPinMsg((!galDraft&&!notesDraft)?"Enter a new PIN in at least one field.":"PINs updated! Close and reopen the section to use them.");
  };

  // Advanced section
  const ADV_KEY="us_admin_pw";
  const[advOpen,setAdvOpen]=useState(false);
  const[advPw,setAdvPw]=useState("");
  const[advErr,setAdvErr]=useState("");
  const[apiDraft,setApiDraft]=useState(fbApiKey||"");
  const[dbDraft,setDbDraft]=useState(fbDbUrl||"");
  const[newAdvPw,setNewAdvPw]=useState("");
  const[advPwMsg,setAdvPwMsg]=useState("");
  const[testBday,setTestBday]=useState(null);

  const tryAdvUnlock=()=>{
    const stored=gs(ADV_KEY,"Raza2026");
    if(advPw===stored){setAdvOpen(true);setAdvErr("");}
    else{setAdvErr("Incorrect password.");}
  };
  const saveAdvPw=()=>{
    if(newAdvPw.length<4){setAdvPwMsg("Must be at least 4 characters.");return;}
    ss(ADV_KEY,newAdvPw);setNewAdvPw("");setAdvPwMsg("Password updated ✓");
    setTimeout(()=>setAdvPwMsg(""),3000);
  };
  const connectFb=()=>{
    FIREBASE_API_KEY=apiDraft;
    FIREBASE_DB_URL=dbDraft;
    setFbApiKey(apiDraft);
    setFbDbUrl(dbDraft);
    ss("fb_api_key",apiDraft);
    ss("fb_db_url",dbDraft);
  };

  return(
    <div className="us-page pf">
      <div className="row-bw"><EditTitle value={pageName} onSave={setPageName}/></div>

      {/* ── Appearance ── */}
      <div className="card">
        <h3 className="card-title" style={{marginBottom:12}}>Appearance</h3>
        <div className="theme-grid">
          {Object.entries(THEMES).map(([k,t])=>(
            <button key={k} className={`theme-card${theme===k?" sel":""}`}
              style={{background:t.bg,border:`2px solid ${theme===k?t.accent:t.bg+"44"}`}}
              onClick={()=>setTheme(k)}>
              <div style={{width:20,height:20,borderRadius:"50%",background:t.accent,margin:"0 auto 5px"}}/>
              <div style={{fontSize:11,fontWeight:600,color:t.ink}}>{t.name}</div>
            </button>
          ))}
        </div>
        <SettingsRow label="Background Image" value={bgImage?"Custom":"Default"} onClick={()=>{setBgDraft(bgImage||"");setSheet("bg");}}/>
      </div>

      {/* ── Names & Story ── */}
      <div className="card">
        <h3 className="card-title" style={{marginBottom:4}}>Names & Story</h3>
        <SettingsRow label="Page Names" onClick={()=>{setNameDraft({...names});setSheet("pageNames");}}/>
        <SettingsRow label="Your Name & Their Name" onClick={()=>{setSN(myName);setST(theirName);setSheet("profile");}}/>
        <div className="srow">
          <span style={{fontSize:14,fontWeight:500,color:"var(--ink)"}}>Together since</span>
          <span className="cap">{new Date(startDate).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}</span>
        </div>
      </div>

      {/* ── Privacy & Security ── */}
      <div className="card">
        <h3 className="card-title" style={{marginBottom:4}}>Privacy & Security</h3>
        <SettingsRow label="Gallery PIN" value="Change" onClick={()=>{setGalDraft("");setPinMsg("");setSheet("galPin");}}/>
        <SettingsRow label="Private Notes PIN" value="Change" onClick={()=>{setNotesDraft("");setPinMsg("");setSheet("notesPin");}}/>
      </div>

      {/* ── Welcome & Music ── */}
      <div className="card">
        <h3 className="card-title" style={{marginBottom:4}}>Welcome & Music</h3>
        <SettingsRow label="Replay Welcome Intro" value="💕" onClick={onReplayIntro}/>
        <div style={{marginTop:8,marginBottom:4}}>
          <div className="lbl" style={{marginBottom:6}}>Intro music — plays per account</div>
          {[
            {role:"uthmaan",label:ROLE_NAMES.uthmaan,val:musicEnabledUth},
            {role:"areebah",label:ROLE_NAMES.areebah,val:musicEnabledAreebah},
          ].map(r=>(
            <label key={r.role} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,cursor:"pointer",padding:"9px 0",borderBottom:"1px solid var(--border)"}}>
              <span style={{fontSize:13,fontWeight:600,color:"var(--ink)"}}>Play for {r.label}</span>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div onClick={()=>toggleMusicFor(r.role,!r.val)} style={{width:38,height:22,background:r.val?"var(--accent)":"var(--border)",borderRadius:50,position:"relative",transition:".2s",flexShrink:0,cursor:"pointer"}}>
                  <div style={{position:"absolute",top:3,left:r.val?17:3,width:16,height:16,background:"#fff",borderRadius:"50%",transition:".2s",boxShadow:"0 1px 4px rgba(0,0,0,.2)"}}/>
                </div>
                <span style={{fontSize:11,fontWeight:500,color:"var(--slate)",width:26}}>{r.val?"On":"Off"}</span>
              </div>
            </label>
          ))}
        </div>
        <SettingsRow label="Audio File" value={musicHasFile?(musicFileName||"Set"):"None"} onClick={()=>setSheet("musicFile")}/>
        <SettingsRow label="Spotify Link" value={spotifyUrl?"Set":"None"} onClick={()=>setSheet("spotify")}/>
        {musicHasFile&&<button className="btn-p" style={{marginTop:12}} onClick={musicPlaying?stopMusic:onTestMusic}>
          {musicPlaying?"⏹ Stop Music":"▶ Test Music Now"}
        </button>}
      </div>

      {/* ── Advanced (password protected) ── */}
      <div className="card">
        <h3 className="card-title" style={{marginBottom:10}}>Advanced</h3>
        {!advOpen?(
          <div>
            <p className="cap" style={{marginBottom:12}}>Restricted access — Firebase setup, feature testing, and developer options.</p>
            <input className="field" type="password" placeholder="Admin password"
              value={advPw} onChange={e=>setAdvPw(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&tryAdvUnlock()}
              style={{marginBottom:10}}/>
            {advErr&&<p style={{color:"#e05050",fontSize:13,marginBottom:10}}>{advErr}</p>}
            <button className="btn-p" onClick={tryAdvUnlock}>Unlock</button>
          </div>
        ):(
          <div>
            <p style={{fontSize:11,fontWeight:700,color:"var(--accent)",letterSpacing:".08em",marginBottom:8,textTransform:"uppercase"}}>🔓 Advanced Unlocked</p>

            <SettingsRow label="Real-Time Sync" value={synced?"Connected":"Local only"} onClick={()=>{setApiDraft(fbApiKey||"");setDbDraft(fbDbUrl||"");setSheet("firebase");}}/>

            {/* Feature testing */}
            <div style={{borderTop:"1px solid var(--border)",paddingTop:14,marginTop:10,marginBottom:16}}>
              <div className="lbl" style={{marginBottom:10}}>🧪 Feature Testing</div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <button className="btn-sm" style={{textAlign:"left",padding:"10px 14px"}}
                  onClick={()=>setTestBday("areebah")}>🌸 Test Areebah's Birthday Animation</button>
                <button className="btn-sm" style={{textAlign:"left",padding:"10px 14px"}}
                  onClick={()=>setTestBday("uthmaan")}>💙 Test Uthmaan's Birthday Animation</button>
                <button className="btn-sm" style={{textAlign:"left",padding:"10px 14px"}}
                  onClick={onReplayIntro}>💕 Test Welcome Intro</button>
              </div>
            </div>

            <SettingsRow label="Admin Password" onClick={()=>{setNewAdvPw("");setAdvPwMsg("");setSheet("adminPw");}}/>
            <SettingsRow label="Storage Info" onClick={()=>setSheet("storage")}/>

            <button style={{marginTop:16,background:"none",border:"none",cursor:"pointer",fontSize:12,color:"var(--muted)",fontWeight:600}} onClick={()=>{setAdvOpen(false);setAdvPw("");}}>
              🔒 Lock Advanced
            </button>
          </div>
        )}
      </div>

      {/* ── Sheets ── */}
      {sheet==="bg"&&<SettingsSheet title="Background Image" onClose={closeSheet}>
        <p className="cap" style={{marginBottom:10}}>Paste an image URL, or leave blank for the theme's solid colour.</p>
        <input className="field" placeholder="https://…" value={bgDraft} onChange={e=>setBgDraft(e.target.value)} style={{marginBottom:12}}/>
        <button className="btn-p" onClick={()=>{setBgImage(bgDraft||null);closeSheet();}}>Save</button>
      </SettingsSheet>}

      {sheet==="pageNames"&&<SettingsSheet title="Page Names" onClose={closeSheet}>
        {Object.entries(nameDraft).map(([k,v])=>(
          <div key={k} className="srow">
            <span style={{fontSize:13,color:"var(--slate)",textTransform:"capitalize",width:80}}>{k}</span>
            <input className="field" style={{flex:1,padding:"5px 8px",fontSize:13}} value={v}
              onChange={e=>setNameDraft(d=>({...d,[k]:e.target.value}))}/>
          </div>
        ))}
        <button className="btn-p" style={{marginTop:14}} onClick={()=>{setNames(nameDraft);closeSheet();}}>Save Names</button>
      </SettingsSheet>}

      {sheet==="profile"&&<SettingsSheet title="Your Name & Their Name" onClose={closeSheet}>
        {[{l:"Your Name",v:sN,s:setSN},{l:"Their Name",v:sT,s:setST}].map(f=>(
          <div key={f.l} style={{marginBottom:10}}>
            <div className="lbl" style={{marginBottom:5}}>{f.l}</div>
            <input className="field" value={f.v} onChange={e=>f.s(e.target.value)}/>
          </div>
        ))}
        <button className="btn-p" style={{marginTop:4}} onClick={()=>{onSettings({myName:sN,theirName:sT,startDate});closeSheet();}}>Save</button>
      </SettingsSheet>}

      {sheet==="galPin"&&<SettingsSheet title="Gallery PIN" onClose={closeSheet}>
        <p className="cap" style={{marginBottom:12}}>Exactly 5 digits. Protects the shared Gallery for both of you.</p>
        <input className="field" type="password" inputMode="numeric" maxLength={5}
          placeholder="New 5-digit PIN" value={galDraft} autoFocus
          onChange={e=>setGalDraft(e.target.value.replace(/\D/g,"").slice(0,5))}
          style={{marginBottom:12,letterSpacing:6,fontSize:20,textAlign:"center"}}/>
        {pinMsg&&<p style={{fontSize:13,color:pinMsg.includes("updated")?"#2e7d32":"#e05050",marginBottom:10,textAlign:"center"}}>{pinMsg}</p>}
        <button className="btn-p" onClick={()=>{savePins();if(galDraft.length===5)closeSheet();}}>Save PIN</button>
      </SettingsSheet>}

      {sheet==="notesPin"&&<SettingsSheet title="Private Notes PIN" onClose={closeSheet}>
        <p className="cap" style={{marginBottom:12}}>Exactly 5 digits. This one's local to your own device only.</p>
        <input className="field" type="password" inputMode="numeric" maxLength={5}
          placeholder="New 5-digit PIN" value={notesDraft} autoFocus
          onChange={e=>setNotesDraft(e.target.value.replace(/\D/g,"").slice(0,5))}
          style={{marginBottom:12,letterSpacing:6,fontSize:20,textAlign:"center"}}/>
        {pinMsg&&<p style={{fontSize:13,color:pinMsg.includes("updated")?"#2e7d32":"#e05050",marginBottom:10,textAlign:"center"}}>{pinMsg}</p>}
        <button className="btn-p" onClick={()=>{savePins();if(notesDraft.length===5)closeSheet();}}>Save PIN</button>
      </SettingsSheet>}

      {sheet==="musicFile"&&<SettingsSheet title="Intro Music File" onClose={closeSheet}>
        <p className="cap" style={{marginBottom:14,lineHeight:1.7}}>MP3, M4A, AAC — max 8MB. One shared file; each account's toggle above controls whether it plays for them.</p>
        {musicHasFile?(
          <div style={{background:"var(--rose)",borderRadius:12,padding:"10px 14px",marginBottom:10,display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:18}}>🎵</span>
            <span style={{fontSize:13,fontWeight:500,color:"var(--ink)",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{musicFileName||"Audio file"}</span>
            <button onClick={()=>{clearMusicFile();}} style={{background:"none",border:"none",cursor:"pointer",color:"var(--accent)",fontSize:12,fontWeight:600,flexShrink:0}}>Remove</button>
          </div>
        ):(
          <button className="btn-sm" style={{width:"100%",padding:"11px",marginBottom:10,borderRadius:12,textAlign:"center"}}
            onClick={()=>musicFileRef.current.click()}>
            📁 Choose Audio File
          </button>
        )}
        <input ref={musicFileRef} type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg" style={{display:"none"}} onChange={handleMusicUpload}/>
        {musicMsg&&<p style={{fontSize:12,color:"var(--accent)",marginTop:10,fontWeight:500}}>{musicMsg}</p>}
      </SettingsSheet>}

      {sheet==="spotify"&&<SettingsSheet title="Spotify Link" onClose={closeSheet}>
        <p className="cap" style={{marginBottom:10}}>Optional — shows an embedded player. Spotify can't autoplay in a browser, so this is just a preview; the uploaded file above is what actually plays automatically.</p>
        <input className="field" placeholder="https://open.spotify.com/track/…"
          value={spotifyUrl} onChange={e=>setSpotifyUrl(e.target.value)}
          style={{marginBottom:10}}/>
        <button className="btn-p" onClick={saveSpotify}>Save Spotify Link</button>
        {spotifyUrl&&(()=>{
          const match=spotifyUrl.match(/track\/([a-zA-Z0-9]+)/);
          if(!match)return<p className="cap" style={{marginTop:8,color:"#e05050"}}>Invalid Spotify link. Paste a full track URL.</p>;
          return(
            <iframe
              src={`https://open.spotify.com/embed/track/${match[1]}?utm_source=generator&theme=0`}
              width="100%" height="80" frameBorder="0"
              allow="autoplay; clipboard-write; encrypted-media; picture-in-picture"
              style={{borderRadius:12,marginTop:12,border:"none"}}
            />
          );
        })()}
      </SettingsSheet>}

      {sheet==="firebase"&&<SettingsSheet title="Real-Time Sync" onClose={closeSheet}>
        <p className="cap" style={{marginBottom:10}}><span className={`sync-dot ${synced?"on":"off"}`}/>{synced?"Connected — both phones sync live":"Not connected — local only"}</p>
        <div className="lbl" style={{marginBottom:4}}>Firebase Web API Key</div>
        <input className="field" placeholder="AIzaSy…" value={apiDraft}
          onChange={e=>setApiDraft(e.target.value)} style={{marginBottom:8}}/>
        <div className="lbl" style={{marginBottom:4}}>Realtime Database URL</div>
        <input className="field" placeholder="https://…firebasedatabase.app"
          value={dbDraft} onChange={e=>setDbDraft(e.target.value)} style={{marginBottom:10}}/>
        <button className="btn-p" onClick={()=>{connectFb();closeSheet();}}>Connect Firebase</button>
        <p className="cap" style={{marginTop:8}}>Free setup: console.firebase.google.com → Create project → Realtime Database → copy URL. Then Project Settings → Web app → copy apiKey.</p>
      </SettingsSheet>}

      {sheet==="adminPw"&&<SettingsSheet title="Change Admin Password" onClose={closeSheet}>
        <input className="field" type="password" placeholder="New admin password" autoFocus
          value={newAdvPw} onChange={e=>setNewAdvPw(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&saveAdvPw()}
          style={{marginBottom:10}}/>
        {advPwMsg&&<p style={{fontSize:13,color:advPwMsg.includes("updated")?"#2e7d32":"#e05050",marginBottom:8}}>{advPwMsg}</p>}
        <button className="btn-p" onClick={saveAdvPw}>Update Password</button>
      </SettingsSheet>}

      {sheet==="storage"&&<SettingsSheet title="Storage Info" onClose={closeSheet}>
        <p className="cap" style={{lineHeight:1.8}}>
          Photos are compressed to ~100KB each. Firebase free tier holds ~7,000–16,000 photos (1GB limit).<br/><br/>
          Videos are stored locally on-device only (LOCAL badge). For shared videos: use Firebase Storage (5GB free on Blaze plan) or share Google Drive links via Fridge notes.<br/><br/>
          Upgrade to Firebase Blaze for ~£0.025/GB/month if you need more.
        </p>
      </SettingsSheet>}

      {/* Birthday test overlay */}
      {testBday&&(()=>{
        const b=BIRTHDAYS.find(bd=>bd.name.toLowerCase()===testBday);
        if(!b)return null;
        const testAge=new Date().getFullYear()-b.year;
        return(
          <div className="lb-overlay" onClick={()=>setTestBday(null)}>
            <Confetti/>
            <div style={{maxWidth:340,width:"100%",borderRadius:20,overflow:"hidden",background:"linear-gradient(140deg,var(--deep),var(--rose))",padding:28,textAlign:"center",position:"relative",zIndex:201}}
              onClick={e=>e.stopPropagation()}>
              <div style={{fontSize:48,marginBottom:10,animation:"heartPulse 1.2s ease infinite"}}>{b.emoji} 🎂 {b.emoji}</div>
              <h3 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:26,fontWeight:600,color:"var(--ink)",marginBottom:10}}>
                Happy Birthday {b.name}! 🎉
              </h3>
              <p style={{fontSize:13,color:"var(--slate)",lineHeight:1.7,marginBottom:6}}>{b.msg}</p>
              <p style={{fontSize:11,color:"var(--muted)",marginBottom:18}}>Turning {testAge} · 🧪 Test Mode</p>
              <button className="btn-p" onClick={()=>setTestBday(null)}>Close Test</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}


/* ═══════════════════════════════════════════
   CONFETTI
═══════════════════════════════════════════ */
function Confetti(){
  const pieces=Array.from({length:44},(_,i)=>{
    const colors=["#C45450","#F3DDD5","#FFD700","#FF85A1","#85D1FF","#A8F0A8","#E8A8F0"];
    return{id:i,left:Math.random()*100,delay:Math.random()*2.4,dur:2+Math.random()*2,
      color:colors[Math.floor(Math.random()*colors.length)],size:5+Math.random()*7,round:Math.random()>.5};
  });
  return(
    <div style={{position:"fixed",inset:0,pointerEvents:"none",overflow:"hidden",zIndex:200}}>
      {pieces.map(p=>(
        <div key={p.id} style={{
          position:"absolute",left:`${p.left}%`,top:-20,
          width:p.size,height:p.size,background:p.color,
          borderRadius:p.round?"50%":"3px",
          animation:`confettiFall ${p.dur}s ${p.delay}s linear infinite`,
        }}/>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════
   BIRTHDAY CARD
═══════════════════════════════════════════ */
function BirthdayCard(){
  function daysUntil(day,month){
    const now=new Date();
    let next=new Date(now.getFullYear(),month-1,day);
    if(next<=now)next.setFullYear(now.getFullYear()+1);
    return Math.ceil((next-now)/86400000);
  }
  function isToday(day,month){const n=new Date();return n.getDate()===day&&n.getMonth()+1===month;}
  function getAge(day,month,year){
    const n=new Date();let age=n.getFullYear()-year;
    if(n.getMonth()+1<month||(n.getMonth()+1===month&&n.getDate()<day))age--;
    return age;
  }
  const pad=n=>String(n).padStart(2,"0");
  const fmtD=ts=>new Date(ts).toLocaleDateString("en-GB",{day:"numeric",month:"short"});
  const fmtDL=ts=>new Date(ts).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"long"});
  const fmtFull=ts=>new Date(ts).toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"});

  const todayBday=BIRTHDAYS.find(b=>isToday(b.day,b.month));
  const[showConf,setShowConf]=useState(!!todayBday);
  useEffect(()=>{
    if(!showConf)return;
    const t=setTimeout(()=>setShowConf(false),8000);
    return()=>clearTimeout(t);
  },[showConf]);

  if(todayBday)return(
    <>
      {showConf&&<Confetti/>}
      <div className="bday-card-today">
        <div style={{fontSize:"clamp(32px,9vw,46px)",marginBottom:10,animation:"heartPulse 1.2s ease infinite"}}>
          {todayBday.emoji} 🎂 {todayBday.emoji}
        </div>
        <h3 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"clamp(18px,5.5vw,24px)",fontWeight:600,color:"var(--ink)",marginBottom:8}}>
          Happy Birthday {todayBday.name}! 🎉
        </h3>
        <p style={{fontSize:13,color:"var(--slate)",lineHeight:1.7,maxWidth:280,margin:"0 auto 10px"}}>
          {todayBday.msg}
        </p>
        <p style={{fontSize:11,color:"var(--muted)"}}>Turning {getAge(todayBday.day,todayBday.month,todayBday.year)+1} today 🌟</p>
        <button style={{marginTop:12,background:"none",border:"none",cursor:"pointer",fontSize:12,color:"var(--accent)",fontWeight:600}}
          onClick={()=>setShowConf(true)}>🎊 Celebrate again</button>
      </div>
    </>
  );

  return(
    <div className="card">
      <h3 className="card-title" style={{marginBottom:12}}>🎂 Birthdays</h3>
      {BIRTHDAYS.map((b,i)=>{
        const days=daysUntil(b.day,b.month);
        const soon=days<=7;
        return(
          <div key={b.name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
            padding:"10px 0",borderBottom:i<BIRTHDAYS.length-1?"1px solid var(--border)":"none"}}>
            <div>
              <span style={{fontSize:18,marginRight:8}}>{b.emoji}</span>
              <span style={{fontWeight:600,fontSize:14,color:"var(--ink)"}}>{b.name}</span>
              <span style={{fontSize:11,color:"var(--muted)",marginLeft:6}}>{b.day}/{b.month}/{b.year}</span>
              {soon&&<span style={{fontSize:9,fontWeight:700,letterSpacing:".1em",textTransform:"uppercase",color:"var(--accent)",display:"block",marginTop:2}}>coming soon ✨</span>}
            </div>
            <div style={{textAlign:"right",flexShrink:0}}>
              <span style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"clamp(17px,5vw,22px)",fontWeight:700,color:soon?"var(--accent)":"var(--ink)"}}>{days}</span>
              <span style={{fontSize:11,color:"var(--muted)",marginLeft:3}}>days</span>
              <div style={{fontSize:10,color:"var(--muted)"}}>turns {getAge(b.day,b.month,b.year)+1}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════
   INTRO SCREEN
═══════════════════════════════════════════ */
function IntroScreen({onDone}){
  const[idx,setIdx]=useState(0);
  const[animKey,setAnimKey]=useState(0);
  const seenVersion=gs("us_intro_version","");
  const isUpdate=seenVersion&&seenVersion!==APP_VERSION;
  const whatNew=isUpdate?[{
    emoji:"✨",title:"Something new.",
    body:`us. has been updated to v${APP_VERSION}.

New this version:
• Birthday tracker with confetti
• Welcome walkthrough
• Intro music on unlock
• Face ID / fingerprint lock
• NFC closes on every refresh`,
    sub:"Tap Next to see the full tour →",
  }]:[];
  const slides=[...whatNew,...INTRO_SLIDES];
  const slide=slides[idx];
  const isLast=idx===slides.length-1;
  const next=()=>{
    if(isLast){ss("us_intro_version",APP_VERSION);onDone();return;}
    setIdx(i=>i+1);setAnimKey(k=>k+1);
  };
  const skip=()=>{ss("us_intro_version",APP_VERSION);onDone();};
  return(
    <div className="intro-screen">
      <div style={{width:"100%",display:"flex",justifyContent:"flex-end",flexShrink:0}}>
        {!isLast&&<button onClick={skip} style={{background:"none",border:"none",cursor:"pointer",
          fontSize:12,fontWeight:600,color:"var(--muted)",letterSpacing:".06em"}}>SKIP</button>}
      </div>
      <div className="intro-slide" key={animKey}>
        <div className="intro-emoji">{slide.emoji}</div>
        <h2 className="intro-title">{slide.title}</h2>
        <p className="intro-body" style={{whiteSpace:"pre-line"}}>{slide.body}</p>
        {slide.sub&&<p className="intro-sub">{slide.sub}</p>}
        {slide.tag&&<p className="intro-tag">{slide.tag}</p>}
      </div>
      <div className="intro-dots">
        {slides.map((_,i)=><div key={i} className={`intro-dot${i===idx?" on":""}`}/>)}
      </div>
      <div className="intro-btns">
        {idx>0&&<button className="btn-p" style={{background:"var(--rose)",color:"var(--ink)",flex:1}}
          onClick={()=>{setIdx(i=>i-1);setAnimKey(k=>k+1);}}>← Back</button>}
        <button className="btn-p" style={{flex:2}} onClick={next}>
          {isLast?"Let us begin 💕":"Next →"}
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   FLOATING MUSIC PLAYER
═══════════════════════════════════════════ */
function FloatingMusicPlayer({audioRef,playing,onStop}){
  if(!playing)return null;
  return(
    <div style={{
      position:"fixed",bottom:"calc(70px + env(safe-area-inset-bottom,0px) + 10px)",
      right:14,zIndex:30,
      background:"var(--sf)",borderRadius:50,
      boxShadow:"var(--sh-md)",
      display:"flex",alignItems:"center",gap:8,
      padding:"8px 14px 8px 10px",
      border:"1px solid var(--border)",
      animation:"introIn .3s ease",
    }}>
      <span style={{fontSize:16,animation:"hb 2s ease infinite"}}>🎵</span>
      <span style={{fontSize:12,fontWeight:600,color:"var(--ink)",maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
        Intro music
      </span>
      <button onClick={onStop} style={{background:"var(--rose)",border:"none",borderRadius:50,width:26,height:26,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:"var(--accent)"}}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════
   BOTTOM NAV
═══════════════════════════════════════════ */
function BottomNav({page,nav,names}){
  return(
    <nav className="us-nav">{NAV_IDS.map(id=>{const Ic=NAV_ICS[id];return(
      <button key={id} className={`nav-item${page===id?" on":""}`} onClick={()=>nav(id)}>
        <span className="nav-ic"><Ic/></span>
        <span className="nav-lb">{names[id]||DEF_NAMES[id]}</span>
      </button>
    );})}</nav>
  );
}

/* ═══════════════════════════════════════════
   ROOT APP
═══════════════════════════════════════════ */
export default function App(){
  // NFC gate
  const[nfcOk,setNfcOk]=useState(false);
  const[bioOk,setBioOk]=useState(false);
  const[showIntro,setShowIntro]=useState(false);
  // Intro music
  const audioRef=useRef(null);
  const[musicPlaying,setMusicPlaying]=useState(false);
  // Auth gate
  const[user,setUser]=useState(()=>{ const u=gs("auth_user",null); return u&&(Date.now()-u.ts<7*86400000)?u:null; });
  const[tokenReady,setTokenReady]=useState(false);
  // Which account is signed in decides who "me" and "them" are — never a per-device default
  const myRole=user?(ROLE_BY_EMAIL[(user.email||"").toLowerCase()]||"uthmaan"):null;
  const theirRole=myRole?otherRole(myRole):null;
  // App state
  const[page,setPage]=useState("home");
  // Custom display names and the anniversary date are shared, permanent
  // data — synced through Firebase (keyed by role) like everything else,
  // not left local-only where a history clear would wipe them.
  const[myName,setMyName]=useSync("name_"+(myRole||"uthmaan"),ROLE_NAMES[myRole||"uthmaan"]);
  const[theirName,setTheirName]=useSync("name_"+(theirRole||"areebah"),ROLE_NAMES[theirRole||"areebah"]);
  const[startDate,setStartDate]=useSync("start_date",DEF_START);
  const[names,setNamesState]=useSync("page_names",DEF_NAMES);
  const[moodEmojis,setMoodEmojisState]=useSync("mood_emojis",DEF_MOODS);
  const[connEmoji,setConnEmojiState]=useSync("conn_emoji","💕");
  const[theme,setThemeState]=useSync("app_theme","blush");
  const[bgImage,setBgImageState]=useSync("app_bg",null);
  // Change "" to your actual Firebase credentials so they survive history clears!
const [fbApiKey, setFbApiKey] = useState(() => gs("fb_api_key", "AIzaSyAc1LN7uRNdrSkejFXdjh8CiCQJPCIYU1A"));
const [fbDbUrl, setFbDbUrl] = useState(() => gs("fb_db_url", "https://ustag-22e9c-default-rtdb.firebaseio.com"));
  const[synced,setSynced]=useState(false);

  // Init Firebase from saved config
  useEffect(()=>{ if(fbApiKey&&fbDbUrl){FIREBASE_API_KEY=fbApiKey;FIREBASE_DB_URL=fbDbUrl;setSynced(true);} },[fbApiKey,fbDbUrl]);

  // Keep the Firebase ID token fresh — every DB read/write needs it (RTDB rules require auth).
  // Also warm the local cache for room-wide settings (music file + this account's
  // play toggle) BEFORE flipping tokenReady, so by the time the biometric gate
  // fires — the very first unlock, not just the second — the data is already
  // there and intro music can autoplay immediately inside that gesture.
  useEffect(()=>{
    if(!user){setTokenReady(false);return;}
    let cancelled=false;
    (async()=>{
      let tok=FIREBASE_ID_TOKEN;
      if(!tok)tok=await refreshFirebaseToken();
      if(cancelled)return;
      if(!tok){
        // Session predates this build (no refreshToken saved) or the refresh
        // token was revoked — bounce back to sign-in so a fresh login can
        // populate a real session instead of silently running unauthenticated.
        ss("auth_user",null);
        setUser(null);
        return;
      }
      try{
        const[myMusicOn,fileB64,fileName,spotify]=await Promise.all([
          dbGet(`room/music_enabled_${myRole}`),
          dbGet("room/music_file_b64"),
          dbGet("room/music_file_name"),
          dbGet("room/music_spotify_url"),
        ]);
        if(myMusicOn!=null)ss(`music_enabled_${myRole}`,!!myMusicOn);
        if(fileB64!=null)ss("music_file_b64",fileB64);
        if(fileName!=null)ss("music_file_name",fileName);
        if(spotify!=null)ss("music_spotify_url",spotify);
      }catch{}
      if(cancelled)return;
      setTokenReady(true);
    })();
    const iv=setInterval(refreshFirebaseToken,50*60*1000);
    return()=>{cancelled=true;clearInterval(iv);};
  },[user,myRole]);

  // Keep those same values live for the rest of the session (e.g. partner
  // uploads a new song, or flips your play toggle, while you're already in)
  useEffect(()=>{
    if(!tokenReady||!myRole)return;
    const unsubs=[
      dbListen(`room/music_enabled_${myRole}`,v=>ss(`music_enabled_${myRole}`,!!v)),
      dbListen("room/music_file_b64",v=>ss("music_file_b64",v)),
      dbListen("room/music_file_name",v=>ss("music_file_name",v)),
      dbListen("room/music_spotify_url",v=>ss("music_spotify_url",v)),
    ];
    return()=>unsubs.forEach(u=>u&&u());
  },[tokenReady,myRole]);

  // Live Location — runs here at the root, not inside DistanceCard, so it
  // keeps updating in the background no matter which page you're on, not
  // just while Home happens to be mounted. Throttled to avoid spamming
  // Firebase: at most once every 30s, or sooner if you've moved 50m+.
  const[liveLocOn]=useSync("live_loc_"+(myRole||"uthmaan"),false);
  useEffect(()=>{
    if(!tokenReady||!myRole||!liveLocOn||!navigator.geolocation)return;
    let lastWrite={ts:0,lat:null,lon:null};
    const id=navigator.geolocation.watchPosition(p=>{
      const{latitude:lat,longitude:lon}=p.coords;
      const now=Date.now();
      const movedKm=lastWrite.lat==null?Infinity:hav(lastWrite.lat,lastWrite.lon,lat,lon);
      if(now-lastWrite.ts<30000&&movedKm*1000<50)return;
      lastWrite={ts:now,lat,lon};
      const loc={lat,lon,ts:now};
      ss(`sync_loc_${myRole}`,loc);
      dbWrite(`room/loc_${myRole}`,loc);
    },()=>{},{enableHighAccuracy:true,maximumAge:15000,timeout:20000});
    return()=>navigator.geolocation.clearWatch(id);
  },[tokenReady,myRole,liveLocOn]);

  // One-time migration: names and the start date used to live only in this
  // device's localStorage, before they synced through Firebase. If this
  // browser still has one of those old local-only values and Firebase has
  // never seen it, push it across once so nobody's already-customized name
  // or the real anniversary date gets silently reset to the default.
  useEffect(()=>{
    if(!tokenReady||!myRole||!theirRole)return;
    const legacyMyName=gs(`name_${myRole}`,null);
    if(legacyMyName&&gs(`sync_name_${myRole}`,null)===null)setMyName(legacyMyName);
    const legacyTheirName=gs(`name_${theirRole}`,null);
    if(legacyTheirName&&gs(`sync_name_${theirRole}`,null)===null)setTheirName(legacyTheirName);
    const legacyStart=gs("start_date",null);
    if(legacyStart&&gs("sync_start_date",null)===null)setStartDate(legacyStart);
    const legacyGalPin=gs("gal_pin",null);
    if(legacyGalPin&&legacyGalPin!=="69420"&&gs("sync_gal_pin",null)===null)dbWrite("room/gal_pin",legacyGalPin).then(()=>ss("sync_gal_pin",legacyGalPin));
  },[tokenReady,myRole,theirRole]);
  const setTheme=v=>{setThemeState(v);};
  const setBgImage=v=>{setBgImageState(v);};
  const setMoodEmojis=v=>setMoodEmojisState(v);
  const setConnEmoji=v=>setConnEmojiState(v);
  const setNames=v=>setNamesState(v);

  // CSS injection — always keep head style in sync with theme
  useEffect(()=>{
    let s=document.getElementById("us-css");
    if(!s){s=document.createElement("style");s.id="us-css";document.head.appendChild(s);}
    s.textContent=buildCSS(theme,bgImage);
  },[theme,bgImage]);

  const onSettings=({myName:n,theirName:t,startDate:s})=>{setMyName(n);setTheirName(t);setStartDate(s);};
  const onAuth=email=>{setUser({email});};
  const makeNameSetter=key=>v=>setNames({...names,[key]:v});

  const isHome=page==="home";

  // ── Gates ──────────────────────────────────
  const handleNfcPass=()=>{
    setNfcOk(true);
    // Intro check happens after biometric, not here
  };
  const playMusicFile=()=>{
    const b64=gs('music_file_b64',null);
    if(!b64)return;
    try{
      if(!audioRef.current)audioRef.current=new Audio();
      audioRef.current.src=b64;
      audioRef.current.loop=false;
      audioRef.current.volume=1;
      audioRef.current.play()
        .then(()=>setMusicPlaying(true))
        .catch(()=>{}); // autoplay blocked — silently fail
    }catch(e){}
  };
  const startIntroMusic=async()=>{
    if(!myRole)return;
    let on=gs(`music_enabled_${myRole}`,null);
    if(on===null){
      // No local answer cached yet (fresh device, or history/site-data was
      // just cleared) — ask Firebase directly so the very first unlock
      // always reflects the true toggle, even if the pre-warm step above
      // somehow missed it. This is the account's own manually-set switch,
      // never reset by anything except that switch being flipped again.
      try{
        const v=await dbGet(`room/music_enabled_${myRole}`);
        on=!!v;
        ss(`music_enabled_${myRole}`,on);
      }catch{ on=false; }
    }
    if(!on)return;
    playMusicFile();
  };

  const stopMusic=()=>{
    if(audioRef.current){audioRef.current.pause();audioRef.current.currentTime=0;}
    setMusicPlaying(false);
  };

  const handleBioPass=()=>{
    setBioOk(true);
    const seenVersion=gs('us_intro_version','');
    const isFirstTime=!seenVersion;
    const wantsIntro=gs('show_intro_on_scan',false);
    const isUpdate=seenVersion&&seenVersion!==APP_VERSION;
    if(isFirstTime||wantsIntro||isUpdate)setShowIntro(true);
    // Room data was already warmed before this gate rendered (see the
    // tokenReady effect above), so play right away — still inside the
    // WebAuthn gesture's activation window, no artificial delay needed.
    startIntroMusic();
  };
  if(!nfcOk)return(<ErrorBoundary><div className="us-app"><style>{buildCSS(theme,bgImage)}</style><NFCGate onPass={handleNfcPass}/></div></ErrorBoundary>);
  if(!user)return(<ErrorBoundary><div className="us-app"><style>{buildCSS(theme,bgImage)}</style><AuthScreen
    onAuth={onAuth}
    initFbKey={fbApiKey}
    initFbUrl={fbDbUrl}
    onFbSave={(key,url)=>{
      FIREBASE_API_KEY=key;
      FIREBASE_DB_URL=url;
      setFbApiKey(key);
      setFbDbUrl(url);
      ss("fb_api_key",key);
      ss("fb_db_url",url);
      setSynced(true);
    }}
  /></div></ErrorBoundary>
  );
  if(!tokenReady)return(<ErrorBoundary><div className="us-app"><style>{buildCSS(theme,bgImage)}</style><div className="nfc-wrap"><div style={{fontSize:"clamp(44px,12vw,56px)",marginBottom:16}}>💕</div><div className="spinner" style={{margin:"16px auto"}}/></div></div></ErrorBoundary>);
  if(!bioOk)return(<ErrorBoundary><div className="us-app"><style>{buildCSS(theme,bgImage)}</style><BiometricGate onPass={handleBioPass} onUnsupported={handleBioPass}/></div></ErrorBoundary>);
  return(
    <ErrorBoundary>
    <div className="us-app">
      <style>{buildCSS(theme,bgImage)}</style>
      {showIntro&&<IntroScreen onDone={()=>setShowIntro(false)}/>}
      <FloatingMusicPlayer audioRef={audioRef} playing={musicPlaying} onStop={stopMusic}/>
      <header className="us-hdr">
        {isHome
          ?<><div className="logo">us.</div><div style={{display:"flex",alignItems:"center",gap:8}}>{synced&&<span style={{fontSize:9,fontWeight:700,color:"var(--muted)",display:"flex",alignItems:"center"}}><span className="sync-dot on"/>LIVE</span>}<button style={{background:"none",border:"none",cursor:"pointer",fontSize:10,fontWeight:700,letterSpacing:".12em",textTransform:"uppercase",color:"var(--slate)"}} onClick={()=>setPage("gallery")}>GALLERY</button></div></>
          :<><button style={{background:"none",border:"none",cursor:"pointer",color:"var(--slate)",display:"flex",padding:2}} onClick={()=>setPage("home")}><IcBack/></button><span style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"clamp(15px,4.5vw,18px)",fontWeight:600,color:"var(--ink)"}}>{page==="them"?theirName:names[page]||DEF_NAMES[page]||""}</span><div style={{width:24}}/></>}
      </header>
      {page==="home"&&<HomePage myName={myName} theirName={theirName} startDate={startDate} nav={setPage} connEmoji={connEmoji} setConnEmoji={setConnEmoji} myRole={myRole} theirRole={theirRole}/>}
      {page==="them"&&<PartnerProfilePage theirName={theirName} startDate={startDate} theirRole={theirRole}/>}
      {page==="me"&&<MePage myName={myName} theirName={theirName} startDate={startDate} onSettings={onSettings} pageName={names.me||DEF_NAMES.me} setPageName={makeNameSetter("me")} myRole={myRole} moodEmojis={moodEmojis} setMoodEmojis={setMoodEmojis}/>}
      {page==="fridge"&&<FridgePage pageName={names.fridge||DEF_NAMES.fridge} setPageName={makeNameSetter("fridge")} myRole={myRole}/>}
      {page==="dates"&&<DatesPage pageName={names.dates||DEF_NAMES.dates} setPageName={makeNameSetter("dates")}/>}
      {page==="map"&&<MapPage pageName={names.map||DEF_NAMES.map} setPageName={makeNameSetter("map")} myRole={myRole} theirRole={theirRole} myName={myName} theirName={theirName}/>}
      {page==="gallery"&&<GalleryPage pageName={names.gallery||DEF_NAMES.gallery} setPageName={makeNameSetter("gallery")} myName={myName}/>}
      {page==="notes"&&<NotesPage pageName={names.notes||DEF_NAMES.notes} setPageName={makeNameSetter("notes")}/>}
      {page==="settings"&&<SettingsPage pageName={names.settings||DEF_NAMES.settings} setPageName={makeNameSetter("settings")} theme={theme} setTheme={setTheme} bgImage={bgImage} setBgImage={setBgImage} names={names} setNames={setNames} myName={myName} theirName={theirName} startDate={startDate} onSettings={onSettings} fbApiKey={fbApiKey} setFbApiKey={setFbApiKey} fbDbUrl={fbDbUrl} setFbDbUrl={setFbDbUrl} synced={synced} onReplayIntro={()=>setShowIntro(true)} onTestMusic={playMusicFile} musicPlaying={musicPlaying} stopMusic={stopMusic}/>}
      <BottomNav page={page} nav={setPage} names={names}/>
    </div>
    </ErrorBoundary>
  );
}
