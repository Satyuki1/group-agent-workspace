window.__ModuleLoader__.load({id:'@group-agent/dsh-bridge',factory:require=>({
  inject:['uiWorkspace','sidebarRight','sidebarRightTabs','slots','locale','sessions'],
  apply(ctx) {
    const React=require('react'),h=React.createElement;
    const {Button}=require('@deepseek-ai/dsh-client-ui-primitives');
    const spaceId=globalThis.__GROUP_SPACE__;
    if(!spaceId || window.parent===window)return;
    const reply=(type,requestId,extra={})=>parent.postMessage({type,requestId,spaceId,...extra},location.origin);
    let pending,frame,disposed=false,bound,opened;
    let resourcesReady=false;const seenResources=new Set();
    let activity={tasks:[],error:''};
    const listeners=new Set();
    const publish=value=>{activity=value;for(const listener of listeners)listener();};
    const subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener);};
    const snapshot=()=>activity;
    const NS='groupLive';
    const zh={title:'工作直播',description:'群成员共同查看智能体的实时工作',empty:'还没有任务，在聊天中 @ 智能体即可开始。',shared:'群成员共享 · 实时执行',private:'个人工作 · 实时执行',privateEmpty:'在聊天中发送消息，即可开始工作。',queued:'排队中',running:'正在工作',completed:'已完成',failed:'执行失败',cancelled:'已停止',needs_review:'需要核对',waiting_input:'等待补充',waiting_approval:'等待确认',thinking:'正在分析请求',preparing:'准备执行',answering:'正在回复','tool-input':'准备工具调用','tool-running':'正在使用工具',reconnecting:'正在恢复连接',input:'输入',output:'结果',tools:'工具调用',notes:'过程说明',read:'读取文件',write:'写入文件',edit:'编辑文件',shell:'执行命令',pending:'进行中',complete:'已完成',error:'失败',open_browser:'打开网页',bash:'执行命令',openPage:'打开网页'};
    const en={...zh,title:'Live work',description:'Shared Agent activity',empty:'Mention an Agent to begin.',shared:'Shared live activity'};
    ctx.effect(()=>ctx.locale.register(NS,{zh,en}), 'group live dictionaries');
    const t=ctx.locale.bind(NS);
    const type='group-live',provider='@group-agent/live';
    function browserURL(tool){
      if(tool.state!=='completed'||tool.name!=='open_browser'||tool.resource?.kind!=='browser')return;
      try{const url=new URL(tool.resource.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.length>4096||url.origin===location.origin)return;return url.href;}catch{return;}
    }
    function openBrowser(tool){const url=browserURL(tool);if(url)ctx.sidebarRight.openTab('browser',{params:{url}});}
    function revealResources(tasks,after){
      const initial=!resourcesReady;resourcesReady=true;
      for(const task of tasks)for(const tool of task.progress?.tools??[]){
        const key=`${task.id}:${tool.id}`;if(!browserURL(tool)||seenResources.has(key))continue;
        seenResources.add(key);
        if(!initial&&Number.isFinite(after)&&Number.isFinite(tool.completedAt)&&tool.completedAt>=after&&['guide','group-live','browser'].includes(ctx.sidebarRight.active()?.kind))openBrowser(tool);
      }
    }
    function LiveWork(){
      const state=React.useSyncExternalStore(subscribe,snapshot,snapshot);
      const [follow,setFollow]=React.useState(true),tail=React.useRef(null);
      const tasks=state.tasks.filter(task=>['running','queued','waiting_approval','waiting_input'].includes(task.status));
      const shown=tasks.length?tasks:state.tasks.slice(0,4);
      React.useEffect(()=>{if(follow)tail.current?.scrollIntoView({block:'end'});},[state,follow]);
      return h('section',{className:'group-live', 'aria-label':t('title'),'data-group-live':''},
        h('p',{className:'group-live-shared'},t(state.shared===false?'private':'shared')),
        state.error&&h('p',{role:'alert'},state.error),
        !shown.length&&h('p',{className:'group-live-empty'},t(state.shared===false?'privateEmpty':'empty')),
        h('div',{className:'group-live-scroll',onScroll:event=>{const n=event.currentTarget;setFollow(n.scrollHeight-n.scrollTop-n.clientHeight<60);}},
          shown.map(task=>h('details',{key:task.id,className:'group-live-task',open:['running','queued','waiting_input','waiting_approval'].includes(task.status)||undefined,'data-live-task':task.id,'data-task-status':task.status},
            h('summary',{className:'group-live-heading'},h('img',{src:`/avatars/${/^(spark|orbit|pebble|bloom)-(rose|blue|mint|violet|amber|prism)$/.test(task.avatar)?task.avatar:'spark-rose'}.svg`,alt:'','data-working':task.status==='running'||undefined}),h('strong',null,task.agent),h('span',null,t(task.status==='running'?(task.progress?.phase??'running'):task.status))),
            h('p',{className:'group-live-request'},task.summary),
            (task.progress?.tools??[]).map(tool=>h('details',{key:tool.id,'data-tool-call':tool.id,open:tool.state==='running'||undefined},
              h('summary',null,`${zh[tool.name]??t('tools')} · ${tool.state==='completed'?t('complete'):tool.state==='failed'?t('error'):t('pending')}`),
              h('span',{className:'group-live-caption'},t('input')),h('pre',null,tool.input),
              tool.output&&h(React.Fragment,null,h('span',{className:'group-live-caption'},t('output')),h('pre',null,tool.output)),
              browserURL(tool)&&h(Button,{size:'sm',variant:'outline',onClick:()=>openBrowser(tool)},t('openPage')))),
            (task.progress?.messages??[]).filter(note=>note.text!==task.progress?.text).map(note=>h('p',{key:note.seq,className:'group-live-note'},note.text)),
            task.progress?.text&&h('div',{className:'group-live-text','data-stream-text':''},task.progress.text),
            task.error&&h('p',{role:'alert'},task.error))),
          h('div',{ref:tail}))) ;
    }
    ctx.effect(()=>ctx.sidebarRightTabs.register({id:provider,kind:type,title:()=>t('title'),guide:[{id:'open',order:0,title:()=>t('title'),description:()=>t('description')}]}),'group live tab type');
    ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:provider,locale:NS},LiveWork)),'group live tab body');
    ctx.effect(()=>{
      const style=document.createElement('style');
      style.textContent=`.group-live{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:var(--dsw-font-s-14)}.group-live-shared{padding:12px 18px;margin:0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);border-bottom:.5px solid var(--dsw-alias-border-l3)}.group-live-scroll{overflow:auto;min-height:0;flex:1;padding:4px 18px 24px;overflow-anchor:none}.group-live .group-live-task{padding:18px 0;border-bottom:.5px solid var(--dsw-alias-border-l3)}.group-live-heading::-webkit-details-marker{display:none}.group-live-heading{list-style:none;display:flex;align-items:center;gap:8px}.group-live-heading img{width:30px;height:30px}.group-live-heading span{margin-left:auto;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}.group-live-request,.group-live-note{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);white-space:pre-wrap;overflow-wrap:anywhere}.group-live-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;margin-top:12px}.group-live details{padding:10px 0}.group-live summary{cursor:pointer}.group-live pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.6;background:var(--dsw-alias-bg-layer-1);padding:10px;border-radius:var(--dsw-radius-sm);max-height:240px;overflow:auto}.group-live-caption{display:block;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);margin-top:10px}.group-live-empty{margin:48px 24px;color:var(--dsw-alias-label-secondary);line-height:1.7}.group-live img[data-working]{animation:group-live-breathe 2.4s ease-in-out infinite}@keyframes group-live-breathe{50%{transform:translateY(-2px) scale(1.06)}}@media(prefers-reduced-motion:reduce){.group-live img[data-working]{animation:none}}`;
      document.head.append(style);return()=>{style.remove();listeners.clear();};
    },'group live style');
    // The native service announces selection before React adopts its surface.
    // Wait for that adoption; never acknowledge an invisible workspace.
    const reveal=(value,attempt=0)=>{
      cancelAnimationFrame(frame);
      frame=requestAnimationFrame(()=>{
        if(disposed)return;
        try {
          if(!ctx.sidebarRight.isExpanded())ctx.sidebarRight.toggleExpanded();
          if(opened!==value.sessionId){
            // The guide owns the native file/browser/terminal entry points.
            // Migrate only the old forced-live landing, once for this user's layout.
            const key=`group-workspace-entry.v1:${spaceId}:${value.sessionId}`;
            let migrated=false;try{migrated=localStorage.getItem(key)==='1';}catch{}
            if(!migrated&&ctx.sidebarRight.active()?.kind===type)ctx.sidebarRight.openTab('guide');
            try{localStorage.setItem(key,'1');}catch{}
            opened=value.sessionId;
          }
          reply('workspace.ready',value.requestId);
        }catch(error){
          if(attempt<120)reveal(value,attempt+1);
          else reply('workspace.error',value.requestId,{message:'原生工作面未能挂载'});
        }
      });
    };
    const bind=()=>{
      if(!pending || !ctx.sessions.list.getSnapshot().byId[pending.sessionId])return;
      const value=pending;pending=undefined;
      try{if(bound?.conversationId!==value.conversationId){resourcesReady=false;seenResources.clear();}bound=value;publish({...activity,shared:value.shared});ctx.uiWorkspace.openSession(value.sessionId);reveal(value);}
      catch(error){console.error('group workspace bind:',error.message);reply('workspace.error',value.requestId,{message:'无法打开该会话'});}
    };
    const listener=event=>{
      if(event.source!==parent || event.origin!==location.origin)return;
      const value=event.data;
      if(!value || value.spaceId!==spaceId || typeof value.requestId!=='string')return;
      try {
        if(value.type==='workspace.bind' && typeof value.sessionId==='string') {
          pending=value;bind();
        } else if(value.type==='resource.open' && typeof value.address==='string') {
          ctx.sidebarRight.openResource(value.address);
          reply('workspace.ready',value.requestId);
        } else if(value.type==='workspace.live' && bound) {
          ctx.sidebarRight.openTab(type);
        } else if(value.type==='workspace.activity' && bound && value.conversationId===bound.conversationId && Array.isArray(value.tasks)) {
          const tasks=value.tasks.slice(0,30);
          publish({tasks,error:typeof value.error==='string'?value.error:'',shared:bound.shared});
          if(value.ready===true)revealResources(tasks,value.after);
        }
      }catch(error) {console.error('group workspace bind:',error.message);reply('workspace.error',value.requestId,{message:'无法打开该资源'});}
    };
    ctx.effect(()=>{
      window.addEventListener('message',listener);
      const catalogOff=ctx.sessions.list.subscribe(bind);
      reply('workspace.ready','boot');
      return ()=>{disposed=true;cancelAnimationFrame(frame);window.removeEventListener('message',listener);catalogOff();};
    },'group workspace embedding');
  },
})});
