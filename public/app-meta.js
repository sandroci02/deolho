(async function loadAppMeta() {
  const versionElements = document.querySelectorAll('.app-version');

  if (!versionElements.length) {
    return;
  }

  try {
    const response = await fetch('/api/version');
    if (!response.ok) {
      throw new Error('Falha ao obter versao');
    }

    const data = await response.json();
    const versionText = data && data.version ? `v${data.version}` : 'v-';

    versionElements.forEach((element) => {
      element.textContent = versionText;
    });
  } catch (_err) {
    versionElements.forEach((element) => {
      element.textContent = 'v-';
    });
  }
})();
