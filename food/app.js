/* 食品群互動教材 引擎：讀取 window.SUBJECT 產生三個分頁 */
(function(){
  const S = window.SUBJECT;
  if(!S){document.body.innerHTML='<p style="padding:40px">資料尚未載入</p>';return;}
  const $ = (s,r=document)=>r.querySelector(s);
  const $$ = (s,r=document)=>[...r.querySelectorAll(s)];
  const esc = t=>String(t==null?'':t).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

  /* 迷你 Markdown：粗體、換行、表格 */
  function mdTable(src){
    const lines = src.trim().split('\n').filter(l=>l.includes('|'));
    if(lines.length<2) return null;
    const cells = l=>l.replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
    const head = cells(lines[0]);
    const rows = lines.slice(2).map(cells);
    let h='<div class="tbl-wrap"><table><thead><tr>'+head.map(c=>`<th>${inline(c)}</th>`).join('')+'</tr></thead><tbody>';
    rows.forEach(r=>{h+='<tr>'+r.map(c=>`<td>${inline(c)}</td>`).join('')+'</tr>';});
    return h+'</tbody></table></div>';
  }
  function inline(t){return esc(t).replace(/\*\*(.+?)\*\*/g,'<b>$1</b>');}
  function fmt(t){
    if(!t) return '';
    if(t.includes('|')&&/\n/.test(t)){const tb=mdTable(t); if(tb) return tb;}
    return inline(t).replace(/\n/g,'<br>');
  }

  // 統計
  const Q = S.questions;
  const years = [...new Set(Q.map(q=>q.source))];
  const topics = S.topics.filter(t=>Q.some(q=>q.topic===t));
  const topicCount = t=>Q.filter(q=>q.topic===t).length;

  document.title = S.title;
  document.body.classList.add(S.key);

  document.body.innerHTML = `
  <header class="top"><div class="wrap">
    <div class="kicker">${esc(S.kicker||'食品群 歷屆考題互動教材')}</div>
    <h1>${esc(S.title)}</h1>
    <div class="sub">${esc(S.subtitle||'')}</div>
    <div class="stat">
      <span><b>${Q.length}</b>歷屆題目</span>
      <span><b>${topics.length}</b>主題分類</span>
      <span><b>${years.length}</b>份試卷</span>
    </div>
  </div></header>
  <nav class="tabs"><div class="wrap">
    <button data-v="notes" class="on">📘 重點整理</button>
    <button data-v="bank">📝 歷屆題庫</button>
    <button data-v="quiz">🎯 隨機測驗</button>
  </div></nav>
  <main class="wrap">
    <section class="view on" id="v-notes"></section>
    <section class="view" id="v-bank"></section>
    <section class="view" id="v-quiz"></section>
  </main>
  <footer>${esc(S.title)}　|　資料來源：歷屆統一入學測驗、全國高級中等學校技藝競賽學科試題<br>本教材為歷屆考題整理與解析，非官方出版品</footer>`;

  // 分頁切換
  $$('nav.tabs button').forEach(b=>b.onclick=()=>{
    $$('nav.tabs button').forEach(x=>x.classList.toggle('on',x===b));
    $$('section.view').forEach(v=>v.classList.toggle('on',v.id==='v-'+b.dataset.v));
    window.scrollTo(0,0);
  });

  /* ---------- 分頁一：重點整理 ---------- */
  (function(){
    const box = $('#v-notes');
    const notes = S.notes||[];
    let cur = '全部';
    const cats = ['全部', ...notes.map(n=>n.topic)];
    box.innerHTML = `<div class="chips" id="ncat"></div><div id="nlist"></div>`;
    const chipsEl = $('#ncat');
    chipsEl.innerHTML = cats.map(c=>`<button class="chip${c==='全部'?' on':''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
    function render(){
      const list = cur==='全部'?notes:notes.filter(n=>n.topic===cur);
      $('#nlist').innerHTML = list.map((n,i)=>`
        <details class="note"${cur!=='全部'||i===0?' open':''}>
          <summary>${esc(n.topic)}</summary>
          <div class="body">${n.html}</div>
        </details>`).join('') || '<p style="color:var(--muted)">此主題重點整理準備中。</p>';
    }
    chipsEl.onclick = e=>{const b=e.target.closest('.chip'); if(!b)return;
      cur=b.dataset.c; $$('.chip',chipsEl).forEach(x=>x.classList.toggle('on',x===b)); render();};
    render();
  })();

  /* ---------- 題目卡片 HTML ---------- */
  function qCard(q, mode){
    const opts = ['A','B','C','D'].filter(k=>q.options&&q.options[k]!=null);
    const est = /推定答案/.test(q.explain||'');
    return `<div class="q" data-id="${esc(q.id)}" data-ans="${esc(q.answer)}">
      <div class="head">
        <span class="badge">${esc(q.source)}·${q.num}</span>
        <div class="stem">${inline(q.stem)}${q.is_chem?'<span class="tag">化學</span>':''}<span class="tag">${esc(q.topic)}</span></div>
      </div>
      <ul class="opts">${opts.map(k=>`<li data-k="${k}"><span class="k">${k}</span><span>${inline(q.options[k])}</span></li>`).join('')}</ul>
      <div class="reveal"><button>看答案與解析</button></div>
      <div class="explain">
        <div class="ans${est?' est':''}">正解：${esc(q.answer)}${est?'（推定答案）':''}</div>
        <div>${fmt(q.explain)}</div>
        ${q.chart?`<div class="chart">${fmt(q.chart)}</div>`:''}
      </div></div>`;
  }
  function wireCard(el){
    const ansKey = el.dataset.ans;
    const exp = $('.explain',el), opts=$$('.opts li',el);
    let done=false;
    function reveal(pick){
      if(done) return; done=true;
      opts.forEach(li=>{li.classList.add('locked');
        if(li.dataset.k===ansKey) li.classList.add('correct');
        else if(li.dataset.k===pick) li.classList.add('wrong');
      });
      exp.classList.add('show');
      $('.reveal',el).classList.add('hidden');
    }
    opts.forEach(li=>li.onclick=()=>reveal(li.dataset.k));
    $('.reveal button',el).onclick=()=>reveal(null);
  }

  /* ---------- 分頁二：歷屆題庫 ---------- */
  (function(){
    const box=$('#v-bank');
    let cur='全部', kw='';
    box.innerHTML=`
      <div class="search"><input id="q-search" placeholder="🔍 搜尋題目關鍵字（例：均質、梅納、滴定…）"></div>
      <div class="chips" id="bcat"></div>
      <div class="qmeta"><span class="count" id="bcount"></span></div>
      <div id="blist"></div>`;
    const cats=['全部',...topics];
    $('#bcat').innerHTML=cats.map(c=>`<button class="chip${c==='全部'?' on':''}" data-c="${esc(c)}">${esc(c)}${c!=='全部'?`<span class="n">${topicCount(c)}</span>`:''}</button>`).join('');
    function render(){
      let list=Q.filter(q=>(cur==='全部'||q.topic===cur));
      if(kw){const k=kw.toLowerCase();
        list=list.filter(q=>(q.stem+JSON.stringify(q.options)+q.explain).toLowerCase().includes(k));}
      $('#bcount').textContent=`共 ${list.length} 題`;
      const listEl=$('#blist');
      listEl.innerHTML=list.map(q=>qCard(q,'bank')).join('')||'<p style="color:var(--muted)">找不到符合的題目。</p>';
      $$('.q',listEl).forEach(wireCard);
    }
    $('#bcat').onclick=e=>{const b=e.target.closest('.chip');if(!b)return;
      cur=b.dataset.c;$$('.chip',$('#bcat')).forEach(x=>x.classList.toggle('on',x===b));render();};
    let t; $('#q-search').oninput=e=>{clearTimeout(t);t=setTimeout(()=>{kw=e.target.value.trim();render();},200);};
    render();
  })();

  /* ---------- 分頁三：隨機測驗 ---------- */
  (function(){
    const box=$('#v-quiz');
    let scope='全部', size=10;
    function startScreen(){
      box.innerHTML=`<div class="quiz-start">
        <h3>🎯 隨機測驗</h3>
        <p style="color:var(--muted)">從題庫隨機抽題，作答後立即顯示答案與解析。</p>
        <p style="margin-top:16px"><b>選擇範圍</b></p>
        <div class="pill-select" id="qscope"></div>
        <p style="margin-top:16px"><b>題數</b></p>
        <div class="pill-select" id="qsize">
          ${[10,20,30,50].map(n=>`<label${n===10?' class="on"':''}><input type="radio" name="sz" value="${n}"${n===10?' checked':''}>${n} 題</label>`).join('')}
        </div>
        <div class="row"><button class="btn" id="qgo">開始測驗</button></div>
      </div>`;
      const sc=['全部',...topics];
      $('#qscope').innerHTML=sc.map((c,i)=>`<label${i===0?' class="on"':''}><input type="radio" name="sc" value="${esc(c)}"${i===0?' checked':''}>${esc(c)}</label>`).join('');
      $('#qscope').onclick=e=>{const l=e.target.closest('label');if(!l)return;
        $$('#qscope label').forEach(x=>x.classList.remove('on'));l.classList.add('on');
        scope=$('input',l).value;};
      $('#qsize').onclick=e=>{const l=e.target.closest('label');if(!l)return;
        $$('#qsize label').forEach(x=>x.classList.remove('on'));l.classList.add('on');
        size=+$('input',l).value;};
      $('#qgo').onclick=run;
    }
    function run(){
      let pool=Q.filter(q=>scope==='全部'||q.topic===scope);
      pool=[...pool].sort(()=>Math.random()-.5).slice(0,Math.min(size,pool.length));
      let idx=0, correct=0, answered=false;
      function show(){
        const q=pool[idx];
        box.innerHTML=`
          <div class="qmeta"><span class="count">第 ${idx+1} / ${pool.length} 題</span><span class="count">答對 ${correct}</span></div>
          <div class="progress"><i style="width:${idx/pool.length*100}%"></i></div>
          <div id="qhere"></div>
          <div class="row" style="display:flex;gap:10px;justify-content:center;margin-top:8px">
            <button class="btn ghost" id="qquit">結束</button>
            <button class="btn hidden" id="qnext">下一題 ▸</button>
          </div>`;
        const he=$('#qhere'); he.innerHTML=qCard(q,'quiz');
        const card=$('.q',he); const ansKey=q.answer;
        answered=false;
        const opts=$$('.opts li',card), exp=$('.explain',card);
        $('.reveal',card).classList.add('hidden');
        function pick(k){
          if(answered)return; answered=true;
          if(k===ansKey)correct++;
          opts.forEach(li=>{li.classList.add('locked');
            if(li.dataset.k===ansKey)li.classList.add('correct');
            else if(li.dataset.k===k)li.classList.add('wrong');});
          exp.classList.add('show');
          $('#qnext').classList.remove('hidden');
        }
        opts.forEach(li=>li.onclick=()=>pick(li.dataset.k));
        $('#qquit').onclick=()=>result();
        $('#qnext').onclick=()=>{idx++; idx<pool.length?show():result();};
      }
      function result(){
        const pct=pool.length?Math.round(correct/pool.length*100):0;
        box.innerHTML=`<div class="scorebox">
          <p style="color:var(--muted)">測驗完成</p>
          <div class="big">${correct} / ${pool.length}</div>
          <p style="font-size:18px">正確率 ${pct}%</p>
          <div class="row" style="display:flex;gap:10px;justify-content:center;margin-top:16px">
            <button class="btn" id="qagain">再測一次</button></div></div>`;
        $('#qagain').onclick=startScreen;
      }
      if(pool.length===0){startScreen();return;}
      show();
    }
    startScreen();
  })();
})();
