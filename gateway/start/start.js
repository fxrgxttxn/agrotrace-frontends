(() => {
  const BACKENDS = ['express', 'django', 'laravel'];
  const POLL_MS = 10000;

  async function checkOne(backend) {
    try {
      const res = await fetch(`/_health/${backend}`, { cache: 'no-store' });
      if (!res.ok) return false;
      const body = await res.json();
      return body && body.status === 'ok';
    } catch {
      return false;
    }
  }

  function render(backend, ok) {
    const chip = document.querySelector(`[data-backend="${backend}"]`);
    if (!chip) return;
    const text = ok ? 'доступен' : 'недоступен';
    if (chip.textContent !== text) chip.textContent = text;
    chip.dataset.tone = ok ? 'ok' : 'danger';
  }

  async function pollAll() {
    await Promise.all(
      BACKENDS.map(async (backend) => {
        const ok = await checkOne(backend);
        render(backend, ok);
      }),
    );
  }

  pollAll();
  setInterval(pollAll, POLL_MS);
})();
