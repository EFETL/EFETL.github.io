/* EFETL 初級聽力 — 班級成績雲端上傳（第二階段）
   資料流：學生作答 → 存本機(第一階段) → 若已設定班級碼+雲端網址，再 POST 一份到老師的 Google 試算表。
   隱私：endpoint 為空、或學生未填班級碼時，完全不上傳（維持第一階段純本機）。 */
window.EFETL_CLOUD = {
  // 老師部署 Apps Script Web App 後，把網址填在這裡（只需改這一行，全站生效）：
  endpoint: "https://script.google.com/macros/s/AKfycbyr1JovSqvYEXjlLbTVoqhkAHTUbB0gDGz0UY_P30d77D6oJuYYTfxebbTadFZB46iO/exec",

  student: function(){ try{ return JSON.parse(localStorage.getItem('efetl_student')||'null'); }catch(e){ return null; } },
  setStudent: function(o){ try{ localStorage.setItem('efetl_student', JSON.stringify(o)); }catch(e){} },
  enabled: function(){ var s=this.student(); return !!(this.endpoint && s && s.cls); },

  // fire-and-forget 上傳，不阻擋作答、失敗也不影響本機成績
  upload: function(rec){
    try{
      if(!this.enabled()) return;
      var s=this.student();
      var body=Object.assign({cls:s.cls, name:s.name||'', seat:s.seat||''}, rec);
      fetch(this.endpoint, {method:'POST', mode:'no-cors', headers:{'Content-Type':'text/plain;charset=utf-8'}, body:JSON.stringify(body)});
    }catch(e){}
  },

  // 老師端用：JSONP 讀回某班級的成績（Apps Script 不給 CORS，故用 JSONP）
  fetchClass: function(cls, key, cb){
    if(!this.endpoint){ cb({ok:false, err:'尚未設定雲端網址'}); return; }
    var fn='efetlcb_'+Math.random().toString(36).slice(2);
    window[fn]=function(data){ try{ delete window[fn]; }catch(e){} try{ document.body.removeChild(s); }catch(e){} cb(data); };
    var s=document.createElement('script');
    s.src=this.endpoint+'?callback='+fn+'&class='+encodeURIComponent(cls)+'&key='+encodeURIComponent(key)+'&t='+Date.now();
    s.onerror=function(){ cb({ok:false, err:'讀取失敗（網址或網路問題）'}); };
    document.body.appendChild(s);
  }
};
