'use strict';

const api = window.clickitReminders;
const els = {
  form: document.getElementById('add-form'),
  text: document.getElementById('text'),
  windowPick: document.getElementById('window-pick'),
  minutes: document.getElementById('minutes'),
  addError: document.getElementById('add-error'),
  upcoming: document.getElementById('upcoming'),
  upcomingEmpty: document.getElementById('upcoming-empty'),
  nudge: document.getElementById('nudge'),
  nudgeNotice: document.getElementById('nudge-notice'),
  openWindows: document.getElementById('open-windows'),
};

let textWasAutoFilled = false;

function formatWhen(at) {
  const minutes = Math.max(0, Math.round((at - Date.now()) / 60000));
  if (minutes < 1) return 'any moment';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `in ${hours} h ${minutes % 60} min`;
}

function renderReminders(items) {
  els.upcoming.replaceChildren();
  els.upcomingEmpty.classList.toggle('hidden', items.length > 0);
  for (const item of items) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = item.text;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = formatWhen(item.at);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => renderReminders(await api.remove(item.id)));
    li.append(text, when, remove);
    els.upcoming.append(li);
  }
}

function renderWindows(windows) {
  els.openWindows.replaceChildren();
  const previous = els.windowPick.value;
  els.windowPick.replaceChildren(new Option('(none)', ''));
  for (const entry of windows) {
    const label = `${entry.app}: ${entry.title}`;
    els.windowPick.add(new Option(label, label));

    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = label;
    li.append(text);
    els.openWindows.append(li);
  }
  els.windowPick.value = [...els.windowPick.options].some((o) => o.value === previous) ? previous : '';
}

async function refreshWindows() {
  renderWindows(await api.windows());
}

els.windowPick.addEventListener('change', () => {
  const choice = els.windowPick.value;
  if (choice && (els.text.value.trim() === '' || textWasAutoFilled)) {
    els.text.value = `Go back to ${choice}`.slice(0, 200);
    textWasAutoFilled = true;
  }
});
els.text.addEventListener('input', () => {
  textWasAutoFilled = false;
});

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.addError.textContent = '';
  try {
    renderReminders(await api.add(els.text.value, Number(els.minutes.value)));
    els.text.value = '';
    els.windowPick.value = '';
    textWasAutoFilled = false;
  } catch (error) {
    els.addError.textContent = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
});

document.getElementById('save-nudge').addEventListener('click', async () => {
  const saved = await api.setNudge(Number(els.nudge.value));
  els.nudge.value = saved;
  els.nudgeNotice.textContent = saved > 0 ? `Notifying every ${saved} min.` : 'Background nudges are off.';
});

document.getElementById('check-now').addEventListener('click', async () => {
  els.nudgeNotice.textContent = 'Checking…';
  const windows = await api.checkNow();
  renderWindows(windows);
  els.nudgeNotice.textContent = windows.length ? `${windows.length} open window(s) found.` : 'No open windows found.';
});

document.getElementById('close').addEventListener('click', () => api.close());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.close();
});

async function init() {
  renderReminders(await api.list());
  els.nudge.value = await api.getNudge();
  await refreshWindows();
  setInterval(async () => renderReminders(await api.list()), 30000);
}

init();
