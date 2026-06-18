(function () {
  var STYLE_ID = 'bb-sidebar-toggle-style';
  var BUTTON_CLASS = 'bb-sidebar-toggle-button';
  var EXPAND_CLASS = 'bb-sidebar-expand-button';
  var COLLAPSED_CLASS = 'bb-sidebar-is-collapsed';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.bb-sidebar-toggle-button { display: flex; width: 100%; align-items: center; justify-content: center; gap: 8px; margin: 0 0 12px; padding: 9px 12px; border: 1px solid var(--border-primary); border-radius: 10px; background: var(--bg-surface); color: var(--text-secondary); font-size: 12px; font-weight: 700; letter-spacing: .04em; cursor: pointer; }',
      '.bb-sidebar-toggle-button:hover { background: var(--bg-hover); color: var(--text-primary); border-color: var(--border-secondary); }',
      '.bb-sidebar-toggle-button svg, .bb-sidebar-expand-button svg { width: 15px; height: 15px; }',
      '.bb-sidebar-expand-button { position: fixed; left: 0; top: 50%; z-index: 2147483000; display: none; width: 34px; height: 52px; align-items: center; justify-content: center; transform: translateY(-50%); border: 1px solid var(--border-primary); border-left: 0; border-radius: 0 14px 14px 0; background: var(--bg-elevated); color: var(--text-secondary); box-shadow: 0 10px 24px rgba(15, 23, 42, .16); cursor: pointer; }',
      '.bb-sidebar-expand-button:hover { color: var(--text-primary); }',
      'aside[data-bb-sidebar-toggle="true"], main[data-bb-sidebar-main="true"] { transition: transform .18s ease, margin-left .18s ease; }',
      'body.bb-sidebar-is-collapsed aside[data-bb-sidebar-toggle="true"] { transform: translateX(-100%) !important; }',
      'body.bb-sidebar-is-collapsed main[data-bb-sidebar-main="true"] { margin-left: 0 !important; }',
      'body.bb-sidebar-is-collapsed .bb-sidebar-expand-button { display: inline-flex; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  function svg(path) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }

  function setCollapsed(collapsed) {
    document.body.classList.toggle(COLLAPSED_CLASS, collapsed);
  }

  function findReturnButton(aside) {
    var buttons = Array.prototype.slice.call(aside.querySelectorAll('button'));
    return buttons.find(function (button) {
      return /返回项目概览|返回项目列表/.test(button.textContent || '');
    });
  }

  function ensureExpandButton() {
    if (document.querySelector('.' + EXPAND_CLASS)) return;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = EXPAND_CLASS;
    button.title = '展开侧边栏';
    button.setAttribute('aria-label', '展开侧边栏');
    button.innerHTML = svg('<path d="m9 18 6-6-6-6"></path>');
    button.addEventListener('click', function () {
      setCollapsed(false);
    });
    document.body.appendChild(button);
  }

  function install() {
    var aside = document.querySelector('aside');
    var main = document.querySelector('main');
    if (!aside || !main) return;
    aside.setAttribute('data-bb-sidebar-toggle', 'true');
    main.setAttribute('data-bb-sidebar-main', 'true');
    if (aside.querySelector('.' + BUTTON_CLASS)) return;
    var returnButton = findReturnButton(aside);
    if (!returnButton || !returnButton.parentElement) return;

    ensureStyle();
    ensureExpandButton();

    var button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.title = '收起侧边栏';
    button.setAttribute('aria-label', '收起侧边栏');
    button.innerHTML = svg('<path d="m15 18-6-6 6-6"></path>') + '<span>收起侧边栏</span>';
    button.addEventListener('click', function () {
      setCollapsed(true);
    });
    returnButton.parentElement.insertBefore(button, returnButton);
  }

  function scheduleInstall() {
    window.requestAnimationFrame(install);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleInstall, { once: true });
  } else {
    scheduleInstall();
  }

  new MutationObserver(scheduleInstall).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
