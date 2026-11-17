(() => {
  'use strict';
  const send = (event, detail = '') => parent.postMessage({ type: 'webgal:probe', event, detail: String(detail).slice(0, 700) }, location.origin);
  const fatal = /memory access out of bounds|unreachable|Aborted\(|Cannot convert the variable|Script exception|Error occurred|^error:|exception thrown:/i;
  for (const name of ['log', 'error', 'warn']) {
    const original = console[name];
    console[name] = function (...args) {
      original.apply(console, args);
      const line = args.map(String).join(' ');
      if (line === 'WEB_COMPAT_STARTUP_COMPLETE') send('ready');
      if (fatal.test(line)) send('error', line);
    };
  }
  window.addEventListener('error', event => send('error', event.message || event.target?.src || '资源加载失败'), true);
  window.addEventListener('unhandledrejection', event => send('error', event.reason?.message || event.reason));
  window.alert = message => send('error', message);
})();
