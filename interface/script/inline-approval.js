(() => {
    'use strict';
    const modal=document.getElementById('approval-modal');
    let focusBefore;
    window.ZaalisInlineApproval={
        prepare() { if(!modal.isConnected)document.body.append(modal); },
        open(item) {
            focusBefore=document.activeElement;
            modal.className='ui-approval'; modal.inert=false;modal.setAttribute('aria-hidden','false');modal.removeAttribute('aria-modal');modal.setAttribute('role','region');
            const agentView=document.getElementById('view-agents').classList.contains('active');
            const host=item.host || document.getElementById(agentView?'agent-messages':'chat-messages');
            host.append(modal); modal.hidden=false;
            document.getElementById('close-approval').hidden=true;
            modal.scrollIntoView({block:'nearest'});
        },
        close() {
            modal.hidden=true;
            document.body.append(modal);
            if(focusBefore?.isConnected)focusBefore.focus({preventScroll:true});
        }
    };
})();
