/** Runs inside the guest VM. DOM objects and page functions never enter the Worker. */
export const browserPageScript = String.raw`(operation, args) => {
  const hiddenCache = new Map();
  function hidden(el) {
    if (!el || el.nodeType !== 1) return false;
    if (hiddenCache.has(el._nid)) return hiddenCache.get(el._nid);
    const style = getComputedStyle(el);
    const value = Boolean(el.hidden || el.getAttribute('aria-hidden') === 'true' || el.tagName === 'INPUT' && el.type === 'hidden' ||
      style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || hidden(el.parentElement));
    hiddenCache.set(el._nid, value);
    return value;
  }
  function visible(el) {
    return Boolean(el && el.isConnected && !hidden(el));
  }
  function text(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(node.tagName) || hidden(node)) return '';
    if (node.tagName === 'BR') return '\n';
    const content = Array.from(node.childNodes).map(text).join('');
    return ['P','DIV','LI','TR','SECTION','ARTICLE','MAIN','HEADER','FOOTER','H1','H2','H3','H4','H5','H6'].includes(node.tagName) ? '\n' + content + '\n' : content;
  }
  function normalized(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
  function name(el) {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const value = normalized(labelled.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '));
      if (value) return value;
    }
    const label = el.getAttribute('aria-label');
    if (label) return normalized(label);
    if (['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) {
      const labels = Array.from(document.querySelectorAll('label')).filter(label => label.getAttribute('for') === el.id && el.id || label.contains(el));
      if (labels.length) return normalized(labels.map(label => text(label)).join(' '));
      if (['button','submit','reset'].includes(el.type)) return el.value || (el.type === 'submit' ? 'Submit' : '');
      return el.getAttribute('placeholder') || el.getAttribute('title') || '';
    }
    return normalized(el.getAttribute('alt') || text(el) || el.getAttribute('title'));
  }
  function role(el) {
    const explicit = el.getAttribute('role')?.split(/\s+/)[0];
    if (explicit) return explicit;
    const roles = {A:el.hasAttribute('href') ? 'link' : 'generic',BUTTON:'button',TEXTAREA:'textbox',SELECT:el.hasAttribute('multiple') ? 'listbox' : 'combobox',OPTION:'option',IMG:'img',H1:'heading',H2:'heading',H3:'heading',H4:'heading',H5:'heading',H6:'heading',NAV:'navigation',MAIN:'main',ARTICLE:'article',SECTION:'region',ASIDE:'complementary',HEADER:'banner',FOOTER:'contentinfo',UL:'list',OL:'list',LI:'listitem',TABLE:'table',TR:'row',TH:'columnheader',TD:'cell',FORM:'form',DIALOG:'dialog',SUMMARY:'button'};
    if (el.tagName === 'INPUT') return ({checkbox:'checkbox',radio:'radio',range:'slider',number:'spinbutton',button:'button',submit:'button',reset:'button',search:'searchbox'})[el.type] || 'textbox';
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return 'textbox';
    return roles[el.tagName] || 'generic';
  }
  function interactive(el, kind) {
    return ['button','link','textbox','searchbox','checkbox','radio','switch','combobox','listbox','slider','spinbutton','menuitem','tab','option'].includes(kind) || el.hasAttribute('tabindex');
  }
  function locate(optional = false) {
    let el;
    if (args.nodeId !== undefined) el = _wrap(args.nodeId);
    else {
      const matches = Array.from(document.querySelectorAll(args.selector));
      if (matches.length > 1) throw Error('Selector matches multiple elements; use a snapshot reference or a more specific selector');
      el = matches[0];
    }
    if (!el || !el.isConnected) {
      if (optional) return null;
      throw Error('Element missing or stale; take a fresh browser_snapshot');
    }
    return el;
  }
  function actionable(el, editable = false) {
    if (!visible(el)) throw Error('Element is not visible');
    if (el.disabled || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') throw Error('Element is disabled');
    if (editable && (el.readOnly || el.hasAttribute('readonly') || el.getAttribute('aria-readonly') === 'true')) throw Error('Element is readonly');
    if (editable && !['INPUT','TEXTAREA'].includes(el.tagName) && !el.isContentEditable && el.getAttribute('contenteditable') !== 'true') throw Error('Element is not editable');
    if (editable && el.tagName === 'INPUT' && ['checkbox','radio','file','button','submit','reset','image','hidden','range'].includes(el.type)) throw Error('This input type cannot be filled');
  }
  function focus(el) {
    const previous = document.activeElement;
    if (previous === el) return;
    if (previous) { previous.dispatchEvent(new Event('blur')); previous.dispatchEvent(new Event('focusout', {bubbles:true})); }
    el.focus();
    el.dispatchEvent(new Event('focus')); el.dispatchEvent(new Event('focusin', {bubbles:true}));
  }
  function setValue(el, value) {
    if (!['INPUT','TEXTAREA'].includes(el.tagName)) el.textContent = value;
    else {
      const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.selectionStart = el.selectionEnd = value.length;
    }
  }
  switch (operation) {
    case 'snapshot': {
      const root = args.selector || args.nodeId !== undefined ? locate() : document.body;
      const nodes = [];
      function walk(el, depth) {
        if (!el || el.nodeType !== 1 || hidden(el) || ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(el.tagName)) return;
        if (args.depth !== undefined && depth > args.depth) return;
        const kind = role(el);
        const isInteractive = interactive(el, kind);
        if ((!args.interactive || isInteractive) && (!args.compact || kind !== 'generic' || isInteractive)) {
          const node = {role:kind, name:isInteractive || ['heading','img'].includes(kind) ? name(el) : el.getAttribute('aria-label') || '', depth};
          if (isInteractive || ['heading','img'].includes(kind)) node.nodeId=el._nid;
          if (isInteractive) {
            node.interactive=true;
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') node.disabled=true;
            if (['INPUT','TEXTAREA','SELECT'].includes(el.tagName) && el.type !== 'password' && el.value) node.value=el.value;
            if (['checkbox','radio','switch'].includes(kind)) node.checked=['checkbox','radio'].includes(el.type) ? el.checked : el.getAttribute('aria-checked');
          }
          if (args.includeUrls && kind === 'link') node.href=el.href;
          if (el.tagName === 'OPTION' && el.selected) node.selected=true;
          if (/^H[1-6]$/.test(el.tagName)) node.level=Number(el.tagName[1]);
          nodes.push(node);
        }
        for (const child of el.childNodes) {
          if (child.nodeType === 1) walk(child, depth+1);
          else if (!args.interactive && child.nodeType === 3 && normalized(child.textContent)) nodes.push({role:'text',name:normalized(child.textContent),depth:depth+1});
        }
        if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child, depth+1);
      }
      walk(root,0);
      return {url:location.href,title:document.title,nodes};
    }
    case 'visible': return visible(locate(true));
    case 'text': return text(args.selector || args.nodeId !== undefined ? locate() : document.body).replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n\n').trim();
    case 'read': {
      if (args.raw) return {url:location.href,title:document.title,raw:document.documentElement.outerHTML,sections:[]};
      const root = document.querySelector('main,article,[role=main]') || document.body;
      const sections = [];
      let heading = '', level = 0, body = [];
      function flush() { if (heading || body.length) sections.push({heading,level,text:body.join('\n').trim()}); body=[]; }
      function walk(node) {
        if (node.nodeType === 3) { if (normalized(node.textContent)) body.push(normalized(node.textContent)); return; }
        if (node.nodeType !== 1 || hidden(node) || ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','NAV','FOOTER'].includes(node.tagName)) return;
        if (/^H[1-6]$/.test(node.tagName)) { flush(); heading=normalized(text(node)); level=Number(node.tagName[1]); return; }
        for (const child of node.childNodes) walk(child);
      }
      walk(root); flush();
      return {url:location.href,title:document.title,sections};
    }
    case 'target': return {nodeId:locate()._nid,href:locate().closest('a[href]')?.href};
    case 'click': {
      const el=locate(); actionable(el); el.scrollIntoView({block:'center',inline:'center'});
      const rect=el.getBoundingClientRect();
      const covering=rect.width > 0 && rect.height > 0 ? document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2) : null;
      if (covering && covering !== el && !el.contains(covering) && !covering.contains(el)) throw Error('Element is covered by ' + covering.tagName.toLowerCase() + (covering.id ? '#'+covering.id : ''));
      focus(el); el.click(); return true;
    }
    case 'fill': { const el=locate(); actionable(el,true); focus(el); setValue(el,args.text); el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:args.text})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; }
    case 'check': {
      const el=locate(); actionable(el);
      const native=['checkbox','radio'].includes(el.type);
      if (!native && !['checkbox','radio','switch'].includes(role(el))) throw Error('Expected a checkbox, radio or switch');
      if (!args.checked && (el.type === 'radio' || role(el) === 'radio')) throw Error('Radio buttons cannot be unchecked');
      function checked() { return native ? Boolean(el.checked) : el.getAttribute('aria-checked') === 'true'; }
      if (checked() !== args.checked) { focus(el); el.click(); }
      if (checked() !== args.checked) throw Error('Click did not change the checked state');
      return true;
    }
    case 'select': {
      const el=locate(); actionable(el);
      if (el.tagName !== 'SELECT') throw Error('Expected a select element');
      const multiple=el.hasAttribute('multiple');
      if (!multiple && args.values.length > 1) throw Error('Select does not allow multiple values');
      const options=Array.from(el.querySelectorAll('option'));
      const selected=args.values.map(value => options.find(option => option.value === value) || options.find(option => normalized(option.textContent) === value));
      if (selected.some(option => !option || option.disabled)) throw Error('Option is missing or disabled');
      focus(el); for(const option of options) option.selected=selected.includes(option);
      if (!multiple) el.value=selected[0].value;
      el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
      return selected.map(option => option.value);
    }
    case 'scroll': {
      const x=(args.direction === 'left' ? -1 : args.direction === 'right' ? 1 : 0)*args.amount;
      const y=(args.direction === 'up' ? -1 : args.direction === 'down' ? 1 : 0)*args.amount;
      if(args.selector || args.nodeId !== undefined) { const el=locate(); el.scrollLeft+=x; el.scrollTop+=y; el.dispatchEvent(new Event('scroll')); return {x:el.scrollLeft,y:el.scrollTop}; }
      scrollBy(x,y); return {x:scrollX,y:scrollY};
    }
    default: throw Error('Unknown page operation');
  }
}`;
