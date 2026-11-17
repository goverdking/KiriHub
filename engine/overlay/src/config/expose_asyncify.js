// Runs inside the Emscripten module scope as --pre-js.
// Register a preRun callback at the FRONT of the queue so Module.Asyncify is
// available before the shell's runWithFS()/LazyFS.install() callback runs.
(function () {
  try {
    if (typeof Module === 'undefined') return;
    Module.preRun = Module.preRun || [];
    Module.preRun.unshift(function () {
      try {
        if (typeof Asyncify !== 'undefined') {
          Module['Asyncify'] = Asyncify;
          if (typeof window !== 'undefined') window['Asyncify'] = Asyncify;
        }
      } catch (e) {}
    });
  } catch (e) {}
})();
