// Watcher tab switcher — loaded by sidebar.html
(function () {
  const btns   = document.querySelectorAll('.sw-tab-btn');
  const panels = document.querySelectorAll('.sw-tab-panel');

  btns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;

      btns.forEach((b) => b.classList.toggle('active', b.dataset.tab === target));
      panels.forEach((p) => {
        const show = p.dataset.tab === target;
        p.style.display = show ? 'flex' : 'none';
      });

      if (target === 'trade') {
        window.dispatchEvent(new CustomEvent('tradeTabShown'));
      }
    });
  });
})();
