export function attachmentUI({ owns, busy }) {
  const $ = id => document.getElementById(id);
  let collection;
  let pickerRevision = 0;
  let previousIds = new Set();
  const report = error => { $('attachment-feedback').textContent = error.message; };
  const allowed = () => owns() && !busy();
  const importFiles = async files => {
    if (!allowed()) { report(new Error('Wait for the reply to finish before adding sources.')); return; }
    $('attachment-menu').open = false;
    $('attachment-feedback').textContent = '';
    try { await collection.addFiles(files); }
    catch (error) { report(error); }
  };
  $('choose-files').onclick = () => { if (allowed()) $('attachment-files').click(); else report(new Error('Wait for the reply to finish before adding sources.')); };
  $('attachment-files').onchange = event => {
    const files = [...event.target.files];
    event.target.value = '';
    void importFiles(files);
  };
  $('composer').addEventListener('paste', event => {
    const images = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
    if (images.length) { event.preventDefault(); void importFiles(images); }
  });
  let dragDepth = 0;
  document.addEventListener('dragenter', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); dragDepth++; document.body.dataset.fileDrop = 'true';
  });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; delete document.body.dataset.fileDrop; } });
  document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
  document.addEventListener('drop', event => {
    delete document.body.dataset.fileDrop; dragDepth = 0;
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    void importFiles([...event.dataTransfer.files]);
  });
  document.addEventListener('pointerdown', event => { if (!$('attachment-menu').contains(event.target)) $('attachment-menu').open = false; });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('tab-picker').open) { event.preventDefault(); event.stopImmediatePropagation(); closePicker(); }
    else if (event.key === 'Escape' && $('attachment-menu').open) { event.preventDefault(); event.stopImmediatePropagation(); $('attachment-menu').open = false; $('attachment-menu').querySelector('summary').focus(); }
  }, true);
  function closePicker() { pickerRevision++; $('tab-picker').close(); $('attachment-menu').querySelector('summary').focus(); }
  $('close-tab-picker').onclick = closePicker;
  $('tab-picker').addEventListener('cancel', event => { event.preventDefault(); closePicker(); });
  $('choose-tab').onclick = async () => {
    if (!allowed()) return;
    $('attachment-menu').open = false;
    $('tab-choices').replaceChildren();
    $('tab-picker-status').textContent = 'Loading tabs…';
    $('tab-picker').showModal();
    const revision = ++pickerRevision;
    try {
      // Titles/URLs only. No page content is read until an explicit selection
      // and subsequent model read_source call.
      const tabs = (await chrome.tabs.query({ currentWindow: true })).filter(tab => /^https?:/.test(tab.url || ''));
      if (revision !== pickerRevision || !owns()) return;
      $('tab-picker-status').textContent = tabs.length ? 'Only the tab you choose will be attached.' : 'No website tabs in this window.';
      for (const tab of tabs) {
        const button = document.createElement('button');
        button.type = 'button';
        const name = document.createElement('span');
        name.textContent = tab.title || 'Untitled tab';
        const url = document.createElement('small');
        url.textContent = tab.url;
        button.append(name, url);
        button.onclick = async () => {
          if (!allowed()) return;
          try {
            // Request only the chosen origin, directly in this click gesture.
            if (!await chrome.permissions.request({ origins: [`${new URL(tab.url).origin}/*`] })) throw new Error('Website access declined. Choose the tab again to retry.');
            const current = await chrome.tabs.get(tab.id);
            if (current.url !== tab.url || current.status === 'loading') throw new Error('This tab changed. Close the picker and select it again.');
            await collection.addTab(current);
            closePicker();
            $('attachment-feedback').textContent = 'Tab attached. Content is read only when needed for your question.';
          } catch (error) { $('tab-picker-status').textContent = error.message; }
        };
        $('tab-choices').append(button);
      }
    } catch (error) { $('tab-picker-status').textContent = error.message; }
  };
  function render(records) {
    if (!owns()) return;
    const focused = document.activeElement.dataset.removeSource;
    const scrollTop = $('attachment-list').scrollTop;
    const added = records.some(record => !previousIds.has(record.id));
    previousIds = new Set(records.map(record => record.id));
    $('attachment-list').replaceChildren(...records.map(record => {
      const chip = document.createElement('li');
      chip.dataset.state = record.state;
      chip.dataset.sourceId = record.id;
      const copy = document.createElement('span');
      copy.className = 'attachment-copy';
      const name = document.createElement('span');
      name.className = 'attachment-name';
      name.textContent = record.name;
      name.title = record.name;
      const state = document.createElement('small');
      const labels = { loading: 'Importing…', ready: 'Ready', error: 'Import failed', unavailable: 'Select tab again', unsupported: 'Image unsupported' };
      const kind = record.kind === 'pdf' ? `PDF${record.pages ? ` · ${record.pages} ${record.pages === 1 ? 'page' : 'pages'}` : ''}` : record.kind === 'tab' ? 'Tab' : record.kind === 'image' ? 'Image' : 'Text';
      state.textContent = `${kind} · ${labels[record.state]}`;
      copy.append(name, state);
      if (record.note) {
        const note = document.createElement('small');
        note.className = 'attachment-note'; note.textContent = record.note;
        copy.append(note);
      }
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'icon-button';
      remove.textContent = '×'; remove.dataset.removeSource = record.id;
      remove.setAttribute('aria-label', `Remove ${record.name}`);
      remove.onclick = async () => {
        try {
          await collection.remove(record.id);
          $('attachment-feedback').textContent = 'Source removed. Future reads are blocked; earlier messages and provider data cannot be retracted.';
          $('attachment-menu').querySelector('summary').focus();
        } catch (error) { report(error); }
      };
      chip.append(copy, remove);
      return chip;
    }));
    $('attachment-list').hidden = !records.length;
    $('attachment-list').scrollTop = added ? $('attachment-list').scrollHeight : scrollTop;
    $('attachment-count').textContent = records.length ? `${records.length}/10 sources` : '';
    $('source-context-warning').hidden = !records.length;
    if (!busy()) $('stop').disabled = !records.some(record => record.state === 'loading');
    if (focused) {
      const button = [...$('attachment-list').querySelectorAll('button')].find(button => button.dataset.removeSource === focused);
      (button || $('attachment-menu').querySelector('summary')).focus();
    }
  }
  return { render, bind: value => { collection = value; } };
}
