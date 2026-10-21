/* One accessible menu surface, placed in the top layer so panels cannot clip it. */
(() => {
    'use strict';
    let closeCurrent=()=>{};
    function open(anchor,items){
        closeCurrent();
        const menu=document.createElement('div');menu.className='ui-action-menu';menu.setAttribute('role','menu');menu.setAttribute('popover','manual');
        const previous=document.activeElement;
        const close=()=>{
            if(!menu.isConnected)return;
            menu.hidePopover?.();menu.remove();anchor.setAttribute('aria-expanded','false');
            document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',keyboard,true);
            window.removeEventListener('resize',close);document.removeEventListener('scroll',scroll,true);
        };
        const outside=event=>{if(!menu.contains(event.target)&&!anchor.contains(event.target))close();};
        const scroll=event=>{if(!menu.contains(event.target))close();};
        const keyboard=event=>{
            const controls=[...menu.querySelectorAll('button')],index=controls.indexOf(document.activeElement);
            if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();if(previous?.isConnected)previous.focus();}
            if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
                event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?controls.length-1:(index+(event.key==='ArrowUp'?-1:1)+controls.length)%controls.length;controls[next]?.focus();
            }
        };
        for(const item of items){
            const control=document.createElement('button');control.type='button';control.textContent=item.label;control.setAttribute('role','menuitem');
            if(item.danger)control.classList.add('is-danger');
            control.addEventListener('click',()=>{close();item.run();});menu.append(control);
        }
        document.body.append(menu);menu.showPopover?.();
        const rect=anchor.getBoundingClientRect(),width=Math.min(236,innerWidth-24),height=menu.getBoundingClientRect().height;
        Object.assign(menu.style,{width:width+'px',left:Math.max(12,Math.min(rect.right-width,innerWidth-width-12))+'px',top:Math.max(12,Math.min(rect.bottom+6,innerHeight-height-12))+'px'});
        anchor.setAttribute('aria-expanded','true');menu.querySelector('button')?.focus();closeCurrent=close;
        document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',keyboard,true);
        window.addEventListener('resize',close);document.addEventListener('scroll',scroll,true);
    }
    window.ZaalisActionMenu={open};
})();
