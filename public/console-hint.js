// Empty-state hint of the Console (ttyS1) view: a Debian image built before 17 November 2026 has
// no login on ttyS1, so the pane stays empty. The rule is pure (no DOM) so a unit test can check it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConsoleHint = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const TEXT = 'Nothing received yet. Press Enter. If it stays empty, this image has no login on ttyS1: rebuild it with scripts/prepare.sh (images prepared before 17 November 2026).';

  // The hint shows only on a ttyS1 view whose console the pane has selected, until a byte arrives.
  function shouldShow({view, attached, received}) {
    return view === 'console2' && !!attached && !received;
  }

  return {TEXT, shouldShow};
});
