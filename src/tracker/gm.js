/*
 * gm.js -- meatlytics tracker.
 * Zero dependencies. Hard budget: <=3072 bytes gzipped (see scripts/build.js).
 * Every handler is try/catch wrapped: a tracker bug must never break the host page.
 * No cookies, no third-party requests -- everything posts to same-origin
 * POST /gm/e as one batched JSON payload per flush. localStorage is touched
 * only for the ?gm-ignore self-exclusion flag, never for visitor data.
 */
(function(){
"use strict";
var D=document,W=window,N=navigator,L=location;
var SC=D.currentScript;
var SITE=(SC&&SC.dataset.site)||L.hostname;
var RD=SC&&SC.dataset.respectDnt;

/* data-respect-dnt="..." on the script tag: opt in to honoring Do Not Track. */
if(RD&&RD!=="false"&&(N.doNotTrack==="1"||W.doNotTrack==="1"||N.msDoNotTrack==="1")){
  W.gm=function(){};
  return;
}

/* Self-exclusion: visit any page with ?gm-ignore=1 to stop tracking this
   browser (persisted in localStorage -- the one deliberate exception to the
   no-localStorage rule; it stores an opt-OUT, never visitor data).
   ?gm-ignore=0 re-enables. */
try{
  var IG=new URLSearchParams(L.search).get("gm-ignore");
  if(IG==="1")W.localStorage.gm_ignore="true";
  else if(IG==="0")W.localStorage.removeItem("gm_ignore");
  if(W.localStorage.gm_ignore==="true"){
    W.gm=function(){};
    return;
  }
}catch(e){}

var BASE="";
try{if(SC&&SC.src)BASE=new URL(SC.src,L.href).pathname.replace(/\/gm\.js$/,"")}catch(e){}
var EP=BASE+"/gm/e";
var CAP=50;
var q=[];

function add(ev){
  try{
    q.push(ev);
    if(q.length>CAP) q.shift();
  }catch(e){}
}

function send(){
  try{
    if(!q.length) return;
    var body=JSON.stringify({s:SITE,v:1,e:q});
    q=[];
    var sent=false;
    if(N.sendBeacon){
      try{sent=N.sendBeacon(EP,new Blob([body],{type:"application/json"}))}catch(e){}
    }
    if(!sent){
      try{
        fetch(EP,{method:"POST",body:body,keepalive:true,headers:{"Content-Type":"application/json"}})["catch"](function(){});
      }catch(e){}
    }
  }catch(e){}
}

function docH(){
  return D.documentElement.scrollHeight;
}

var path,scrollHit,grid,accMs,visStart,visible;

function reset(){
  scrollHit=[];
  grid={};
}

function flushMouse(){
  try{
    var k=Object.keys(grid);
    if(k.length) add({t:"mouse",p:path,w:W.innerWidth,dh:docH(),g:grid});
    grid={};
  }catch(e){}
}

function tick(){
  if(visible) accMs+=Date.now()-visStart;
  visStart=Date.now();
}

function sendDuration(){
  try{
    tick();
    if(accMs>0) add({t:"duration",p:path,ms:Math.round(accMs)});
    accMs=0;
  }catch(e){}
}

function utm(){
  try{
    var sp=new URLSearchParams(L.search),o={},k=0,m={utm_source:"s",utm_medium:"m",utm_campaign:"c"};
    for(var key in m){
      var v=sp.get(key);
      if(v){o[m[key]]=v;k=1}
    }
    return k?o:undefined;
  }catch(e){}
}

function pageview(){
  try{
    flushMouse();
    sendDuration();
    reset();
    path=L.pathname;
    visible=!D.hidden;
    visStart=Date.now();
    accMs=0;
    add({t:"pageview",p:path,r:D.referrer,u:utm(),w:W.innerWidth});
  }catch(e){}
}

/* common download-file extensions; server treats the rest via content-type if needed */
var DLRE=/\.(dmg|zip|pdf|exe|pkg|tar\.gz|rar|7z|msi|deb|rpm|docx?|xlsx?|pptx?|csv|mp3|mp4|iso|apk)$/i;

D.addEventListener("click",function(e){
  try{
    var x=+(e.pageX/W.innerWidth*100).toFixed(1);
    var y=+(e.pageY/docH()*100).toFixed(1);
    add({t:"click",p:path,x:x,y:y,w:W.innerWidth,dh:docH()});
    var a=e.target.closest&&e.target.closest("a[href]");
    if(a){
      var u=new URL(a.href,L.href);
      if(u.origin!==L.origin) add({t:"outbound",p:path,h:u.hostname});
      if(DLRE.test(u.pathname)) add({t:"download",p:path,f:u.pathname.split("/").pop()});
    }
  }catch(e){}
},true);

D.addEventListener("submit",function(e){
  try{
    var f=e.target;
    add({t:"submit",p:path,f:f.id||f.name||""});
  }catch(e){}
},true);

D.addEventListener("scroll",function(){
  try{
    var pct=(W.scrollY+W.innerHeight)/docH()*100;
    [25,50,75,100].forEach(function(t){
      if(pct>=t&&scrollHit.indexOf(t)<0){
        scrollHit.push(t);
        add({t:"scroll",p:path,d:t});
      }
    });
  }catch(e){}
},{passive:true});

var lastM=0;
D.addEventListener("mousemove",function(e){
  try{
    var now=Date.now();
    if(now-lastM<500) return;
    lastM=now;
    var c=(e.pageX/40)|0,r=(e.pageY/40)|0,k=c+":"+r;
    grid[k]=(grid[k]||0)+1;
  }catch(e){}
},{passive:true});

D.addEventListener("visibilitychange",function(){
  try{
    if(D.hidden){
      flushMouse();
      sendDuration();
      send();
      visible=false;
    }else{
      visible=true;
      visStart=Date.now();
    }
  }catch(e){}
});

W.addEventListener("pagehide",function(){
  try{
    flushMouse();
    sendDuration();
    send();
  }catch(e){}
});

/* SPA support: pushState/replaceState/popstate all count as a new pageview */
var HP=history.pushState,HR=history.replaceState;
history.pushState=function(){
  try{HP.apply(this,arguments)}finally{pageview()}
};
history.replaceState=function(){
  try{HR.apply(this,arguments)}finally{pageview()}
};
W.addEventListener("popstate",pageview);

/* window.gm('name', {props}) -- custom events, drains any pre-load queue stub
   ( window.gm=window.gm||function(){(gm.q=gm.q||[]).push(arguments)} ) */
var oldGm=W.gm;
W.gm=function(n,p){
  try{add({t:"custom",p:path,n:n,pr:p})}catch(e){}
};
try{
  if(oldGm&&oldGm.q) oldGm.q.forEach(function(a){W.gm(a[0],a[1])});
}catch(e){}

/* ?gm-overlay=<token> -- dashboard heatmap preview hook. Lazy-loaded so it never
   costs real visitors a byte; full overlay UX lives in the dashboard bundle. */
try{
  var ov=new URLSearchParams(L.search).get("gm-overlay");
  if(ov) import(BASE+"/gm-overlay.js").then(function(m){m.init(ov)})["catch"](function(){});
}catch(e){}

pageview();
setInterval(send,15000);
})();
