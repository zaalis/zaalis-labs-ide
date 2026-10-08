'use strict';
const { fs, path, publicData, fail }=require('./common');
class DesktopTools {
  constructor(options){this.options=options;}
  async run(name,i,ctx){
    if(name==='desktop_overview')return {project:ctx.root,model:ctx.model,submodel:ctx.submodel,permissions:ctx.permissionMode,terminals:this.options.terminals(ctx),panels:['chat','agents','terminal','browser','files','tools']};
    if(name==='drive_overview')return {drives:process.platform==='win32'?Array.from({length:26},(_,n)=>String.fromCharCode(65+n)+':\\').filter(p=>fs.existsSync(p)):['/'],project:ctx.root};
    if(name==='terminal_read'){const rows=this.options.terminals(ctx),row=i.terminal_id?rows.find(r=>r.id===i.terminal_id):rows.find(r=>r.cwd===ctx.root);if(!row)throw fail('No matching terminal session.','not_found',404);return publicData(row);}
    if(name==='window_read')return this.options.computer(ctx,{action:'observe'});
    if(name==='desktop_project')return this.options.project(ctx,i);
    if(name==='panel_focus'&&!['terminal','browser','chat','agents','files','vm','artifacts','tools'].includes(i.panel))throw fail('Unknown IDE panel.');
    if(name==='apply_layout'&&!['default','focus','coding','research'].includes(i.preset||'default'))throw fail('Unknown layout preset.');
    const event={type:'ui_request',name,input:publicData(i),root:ctx.root};ctx.emit?.(event);this.options.emit(ctx.userId,event);return {requested:true,presentation:'Rendered by a connected IDE; terminal receives the same event.',event};
  }
}
module.exports={DesktopTools};
