// Renders the post-call artefact panel: AI summary, audio player, transcript,
// captured fields, notes editor. Shared between /dashboard (used after a call
// ends) and /calls/:id (standalone review page).
//
// Exposed as window.AgenticzPostCall so this file can be loaded as a classic
// script (no module). Tests do not import this module — it is DOM-only.

(function () {
  const POST_CALL_HTML = `
    <section class="pc-section" data-section="summary">
      <h3 class="pc-heading">AI summary</h3>
      <p class="pc-body" data-slot="summary">No summary available.</p>
    </section>

    <section class="pc-section" data-section="recording">
      <h3 class="pc-heading">Recording</h3>
      <div data-slot="recording">No recording available.</div>
    </section>

    <section class="pc-section" data-section="transcript">
      <h3 class="pc-heading">Transcript</h3>
      <div class="pc-transcript" data-slot="transcript">
        <p class="pc-empty">No transcript yet.</p>
      </div>
    </section>

    <section class="pc-section" data-section="captured">
      <h3 class="pc-heading">Captured fields</h3>
      <dl class="pc-captured" data-slot="captured">
        <dt class="pc-empty">No structured fields captured.</dt>
      </dl>
    </section>

    <section class="pc-section" data-section="notes">
      <h3 class="pc-heading">Operator notes</h3>
      <textarea
        class="pc-notes"
        data-slot="notes-input"
        maxlength="5000"
        rows="4"
        placeholder="Add your notes (will be saved to this call)…"
      ></textarea>
      <div class="pc-notes-actions">
        <button type="button" class="pc-save" data-slot="notes-save">Save notes</button>
        <span class="pc-notes-status" data-slot="notes-status" aria-live="polite"></span>
      </div>
    </section>
  `;

  function humanKey(key) {
    return key
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (c) => c.toUpperCase())
      .trim();
  }

  function formatCapturedValue(value) {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'string') return value || '—';
    return JSON.stringify(value);
  }

  function renderSummary(container, row) {
    const el = container.querySelector('[data-slot="summary"]');
    if (!el) return;
    if (row.aiSummary) {
      el.textContent = row.aiSummary;
      el.classList.remove('pc-empty');
    } else {
      el.textContent = 'No summary available.';
      el.classList.add('pc-empty');
    }
  }

  function renderRecording(container, row) {
    const slot = container.querySelector('[data-slot="recording"]');
    if (!slot) return;
    slot.innerHTML = '';
    if (row.recordingUrl) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = row.recordingUrl;
      audio.className = 'pc-audio';
      slot.appendChild(audio);
    } else {
      const p = document.createElement('p');
      p.className = 'pc-empty';
      p.textContent = 'No recording available.';
      slot.appendChild(p);
    }
  }

  function renderTranscript(container, row) {
    const slot = container.querySelector('[data-slot="transcript"]');
    if (!slot) return;
    slot.innerHTML = '';
    const text = typeof row.transcript === 'string' ? row.transcript.trim() : '';
    if (!text) {
      const p = document.createElement('p');
      p.className = 'pc-empty';
      p.textContent = 'No transcript yet.';
      slot.appendChild(p);
      return;
    }
    // Retell transcripts arrive as plain text with role-prefixed lines,
    // typically "Agent: ..." / "User: ...". Split on blank lines or role
    // prefixes so each turn gets its own row.
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const turn = document.createElement('div');
      turn.className = 'pc-turn';
      const m = /^([A-Za-z][A-Za-z _-]{0,24}):\s*(.*)$/.exec(line);
      if (m) {
        const role = document.createElement('span');
        role.className = 'pc-turn-role';
        role.textContent = m[1];
        const body = document.createElement('span');
        body.className = 'pc-turn-body';
        body.textContent = ' ' + m[2];
        turn.appendChild(role);
        turn.appendChild(body);
      } else {
        turn.textContent = line;
      }
      slot.appendChild(turn);
    }
  }

  function renderCaptured(container, row) {
    const slot = container.querySelector('[data-slot="captured"]');
    if (!slot) return;
    slot.innerHTML = '';
    const fields = row.capturedFields;
    if (!fields || typeof fields !== 'object' || !Object.keys(fields).length) {
      const empty = document.createElement('dt');
      empty.className = 'pc-empty';
      empty.textContent = 'No structured fields captured.';
      slot.appendChild(empty);
      return;
    }
    for (const [key, value] of Object.entries(fields)) {
      const dt = document.createElement('dt');
      dt.textContent = humanKey(key);
      const dd = document.createElement('dd');
      dd.textContent = formatCapturedValue(value);
      slot.appendChild(dt);
      slot.appendChild(dd);
    }
  }

  function renderNotes(container, row, onSave) {
    const textarea = container.querySelector('[data-slot="notes-input"]');
    const saveBtn = container.querySelector('[data-slot="notes-save"]');
    const statusEl = container.querySelector('[data-slot="notes-status"]');
    if (!textarea || !saveBtn || !statusEl) return;

    // Keep the user's in-progress edit if they've already typed something.
    if (document.activeElement !== textarea) {
      textarea.value = row.notes || '';
    }

    if (saveBtn.dataset.wired === '1') return;
    saveBtn.dataset.wired = '1';

    async function handleSave() {
      if (typeof onSave !== 'function') return;
      saveBtn.disabled = true;
      const originalLabel = saveBtn.textContent;
      saveBtn.textContent = 'Saving…';
      statusEl.textContent = '';
      statusEl.classList.remove('pc-error', 'pc-success');

      try {
        const updated = await onSave(textarea.value);
        textarea.value = updated || '';
        statusEl.textContent = 'Saved';
        statusEl.classList.add('pc-success');
        setTimeout(() => {
          statusEl.textContent = '';
          statusEl.classList.remove('pc-success');
        }, 2000);
      } catch (err) {
        const msg = err?.message || 'Could not save notes';
        statusEl.textContent = msg;
        statusEl.classList.add('pc-error');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = originalLabel;
      }
    }

    saveBtn.addEventListener('click', handleSave);
  }

  function render(row, container, { onSave } = {}) {
    if (!container) return;
    if (container.dataset.pcWired !== '1') {
      container.innerHTML = POST_CALL_HTML;
      container.dataset.pcWired = '1';
    }
    renderSummary(container, row);
    renderRecording(container, row);
    renderTranscript(container, row);
    renderCaptured(container, row);
    renderNotes(container, row, onSave);
  }

  window.AgenticzPostCall = { render };
})();
