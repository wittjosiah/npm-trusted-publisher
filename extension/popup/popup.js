// State management.
let state = {
  status: 'idle', // idle, running, paused
  packages: [],
  currentIndex: 0,
  completed: [],
  failed: [],
  skipped: [], // Already configured packages.
  config: {
    owner: 'dxos',
    repository: 'dxos',
    workflow: 'publish-all.yml',
    environment: '',
    navigationMode: 'manual',
    autoSubmit: false,
    delay: 2,
  },
};

// DOM elements.
const elements = {
  owner: document.getElementById('owner'),
  repository: document.getElementById('repository'),
  workflow: document.getElementById('workflow'),
  environment: document.getElementById('environment'),
  navigationMode: document.getElementById('navigationMode'),
  autoSubmit: document.getElementById('autoSubmit'),
  delay: document.getElementById('delay'),
  delayGroup: document.getElementById('delayGroup'),
  packages: document.getElementById('packages'),
  startBtn: document.getElementById('startBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  resumeBtn: document.getElementById('resumeBtn'),
  resetBtn: document.getElementById('resetBtn'),
  nextBtn: document.getElementById('nextBtn'),
  fillBtn: document.getElementById('fillBtn'),
  progressText: document.getElementById('progressText'),
  currentPackage: document.getElementById('currentPackage'),
  progressFill: document.getElementById('progressFill'),
  completedCount: document.getElementById('completedCount'),
  skippedCount: document.getElementById('skippedCount'),
  failedCount: document.getElementById('failedCount'),
  pendingCount: document.getElementById('pendingCount'),
  resultsList: document.getElementById('resultsList'),
  statusMessage: document.getElementById('statusMessage'),
};

// Initialize popup.
async function init() {
  await loadState();
  updateUI();
  setupEventListeners();
  setupTabs();
}

// Load state from storage.
async function loadState() {
  const stored = await chrome.storage.local.get(['trustedPublisherState']);
  if (stored.trustedPublisherState) {
    state = { ...state, ...stored.trustedPublisherState };
    // Ensure skipped array exists (migration for older storage).
    if (!state.skipped) {
      state.skipped = [];
    }
  }

  // Populate form fields.
  elements.owner.value = state.config.owner;
  elements.repository.value = state.config.repository;
  elements.workflow.value = state.config.workflow;
  elements.environment.value = state.config.environment;
  elements.navigationMode.value = state.config.navigationMode;
  elements.autoSubmit.value = String(state.config.autoSubmit);
  elements.delay.value = state.config.delay;
  elements.packages.value = state.packages.join('\n');

  // Show/hide delay group based on navigation mode.
  updateDelayVisibility();
}

// Save state to storage.
async function saveState() {
  await chrome.storage.local.set({ trustedPublisherState: state });
}

// Save config from form inputs.
function saveConfig() {
  state.config = {
    owner: elements.owner.value.trim(),
    repository: elements.repository.value.trim(),
    workflow: elements.workflow.value.trim(),
    environment: elements.environment.value.trim(),
    navigationMode: elements.navigationMode.value,
    autoSubmit: elements.autoSubmit.value === 'true',
    delay: parseInt(elements.delay.value, 10) || 2,
  };
  saveState();
}

// Update delay group visibility.
function updateDelayVisibility() {
  if (elements.navigationMode.value === 'auto') {
    elements.delayGroup.classList.remove('hidden');
  } else {
    elements.delayGroup.classList.add('hidden');
  }
}

// Parse package list.
function parsePackages(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

// Setup event listeners.
function setupEventListeners() {
  // Config change handlers.
  const configInputs = [
    elements.owner,
    elements.repository,
    elements.workflow,
    elements.environment,
    elements.delay,
  ];

  configInputs.forEach((input) => {
    input.addEventListener('change', saveConfig);
    input.addEventListener('blur', saveConfig);
  });

  elements.navigationMode.addEventListener('change', () => {
    updateDelayVisibility();
    saveConfig();
  });

  elements.autoSubmit.addEventListener('change', saveConfig);

  elements.packages.addEventListener('change', () => {
    state.packages = parsePackages(elements.packages.value);
    saveState();
    updateUI();
  });

  // Button handlers.
  elements.startBtn.addEventListener('click', handleStart);
  elements.pauseBtn.addEventListener('click', handlePause);
  elements.resumeBtn.addEventListener('click', handleResume);
  elements.resetBtn.addEventListener('click', handleReset);
  elements.nextBtn.addEventListener('click', handleNext);
  elements.fillBtn.addEventListener('click', handleFillCurrent);
}

// Setup result tabs.
function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      renderResults(tab.dataset.tab);
    });
  });
}

// Handle start button.
async function handleStart() {
  saveConfig();
  state.packages = parsePackages(elements.packages.value);

  if (state.packages.length === 0) {
    showStatus('Please enter at least one package', 'error');
    return;
  }

  if (!state.config.owner || !state.config.repository || !state.config.workflow) {
    showStatus('Please fill in all GitHub configuration fields', 'error');
    return;
  }

  state.status = 'running';
  state.currentIndex = 0;
  state.completed = [];
  state.failed = [];
  state.skipped = [];

  await saveState();
  updateUI();

  // Start processing.
  await processCurrentPackage();
}

// Handle pause button.
async function handlePause() {
  state.status = 'paused';
  await saveState();
  updateUI();
  showStatus('Paused', 'warning');
}

// Handle resume button.
async function handleResume() {
  state.status = 'running';
  await saveState();
  updateUI();
  showStatus('Resumed', 'info');

  // Continue processing.
  await processCurrentPackage();
}

// Handle reset button.
async function handleReset() {
  state.status = 'idle';
  state.currentIndex = 0;
  state.completed = [];
  state.failed = [];
  state.skipped = [];

  await saveState();
  updateUI();
  showStatus('Reset complete', 'info');
}

// Handle next button.
async function handleNext() {
  // Mark current as completed and move to next.
  const currentPkg = state.packages[state.currentIndex];
  if (currentPkg && !state.completed.includes(currentPkg) && !state.failed.includes(currentPkg)) {
    state.completed.push(currentPkg);
  }

  state.currentIndex++;
  await saveState();

  if (state.currentIndex >= state.packages.length) {
    state.status = 'idle';
    await saveState();
    updateUI();
    showStatus('All packages processed!', 'success');
    return;
  }

  updateUI();
  await processCurrentPackage();
}

// Handle fill current page button.
async function handleFillCurrent() {
  saveConfig();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url?.includes('npmjs.com/package/') || !tab.url.includes('/access')) {
    showStatus('Please navigate to a package access page first', 'error');
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, {
      action: 'fillForm',
      config: state.config,
    });
    showStatus('Form filled', 'success');
  } catch (error) {
    showStatus('Failed to fill form: ' + error.message, 'error');
  }
}

// Process current package.
async function processCurrentPackage() {
  if (state.status !== 'running') return;
  if (state.currentIndex >= state.packages.length) {
    state.status = 'idle';
    await saveState();
    updateUI();
    showStatus('All packages processed!', 'success');
    return;
  }

  const pkg = state.packages[state.currentIndex];
  showStatus(`Processing: ${pkg}`, 'info');

  // Navigate to package access page.
  const url = `https://www.npmjs.com/package/${pkg}/access`;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.update(tab.id, { url });

  updateUI();
}

// Update UI based on state.
function updateUI() {
  const isIdle = state.status === 'idle';
  const isRunning = state.status === 'running';
  const isPaused = state.status === 'paused';
  const isManualMode = state.config.navigationMode === 'manual';

  // Button states.
  elements.startBtn.disabled = isRunning;
  elements.pauseBtn.disabled = !isRunning;
  elements.resumeBtn.disabled = !isPaused;
  elements.nextBtn.disabled = !isRunning || !isManualMode;

  // Progress display.
  const total = state.packages.length;
  const current = Math.min(state.currentIndex + 1, total);
  elements.progressText.textContent = `${current} of ${total}`;

  const currentPkg = state.packages[state.currentIndex];
  elements.currentPackage.textContent = currentPkg || '';

  const done = state.completed.length + state.skipped.length;
  const progress = total > 0 ? (done / total) * 100 : 0;
  elements.progressFill.style.width = `${progress}%`;

  // Counts.
  elements.completedCount.textContent = state.completed.length;
  elements.skippedCount.textContent = state.skipped.length;
  elements.failedCount.textContent = state.failed.length;
  elements.pendingCount.textContent = Math.max(
    0,
    state.packages.length - state.completed.length - state.failed.length - state.skipped.length
  );

  // Render results for active tab.
  const activeTab = document.querySelector('.tab.active');
  if (activeTab) {
    renderResults(activeTab.dataset.tab);
  }
}

// Render results list.
function renderResults(type) {
  let items = [];

  switch (type) {
    case 'completed':
      items = state.completed;
      break;
    case 'failed':
      items = state.failed;
      break;
    case 'skipped':
      items = state.skipped;
      break;
    case 'pending':
      items = state.packages.filter(
        (p) =>
          !state.completed.includes(p) && !state.failed.includes(p) && !state.skipped.includes(p)
      );
      break;
  }

  elements.resultsList.innerHTML = items
    .map((pkg) => `<div class="result-item ${type}">${pkg}</div>`)
    .join('');
}

// Show status message.
function showStatus(message, type = 'info') {
  elements.statusMessage.textContent = message;
  elements.statusMessage.className = type;
}

// Listen for messages from content script.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'packageResult') {
    handlePackageResult(message);
  }
});

// Listen for storage changes (content script may update storage directly).
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.trustedPublisherState) {
    const newState = changes.trustedPublisherState.newValue;
    if (newState) {
      state = { ...state, ...newState };
      if (!state.skipped) state.skipped = [];
      updateUI();

      // Update status message based on state.
      if (state.status === 'idle' && state.currentIndex >= state.packages.length) {
        showStatus('All packages processed!', 'success');
      } else if (state.status === 'running') {
        const currentPkg = state.packages[state.currentIndex];
        if (currentPkg) {
          showStatus(`Processing: ${currentPkg}`, 'info');
        }
      }
    }
  }
});

// Handle result from content script.
async function handlePackageResult(message) {
  const { success, packageName, error, alreadyConfigured, notFound, completed } = message;

  console.log('[popup] handlePackageResult:', message);

  if (success) {
    if (alreadyConfigured && !completed) {
      // Track skipped packages separately (was already configured before this session).
      if (!state.skipped.includes(packageName)) {
        state.skipped.push(packageName);
      }
      // Remove from completed if it was added there.
      state.completed = state.completed.filter((p) => p !== packageName);
      showStatus(`Already configured: ${packageName}`, 'info');
    } else if (notFound) {
      // Track not found packages as skipped.
      if (!state.skipped.includes(packageName)) {
        state.skipped.push(packageName);
      }
      showStatus(`Not found (404): ${packageName}`, 'warning');
    } else {
      // Successfully configured during this session.
      if (!state.completed.includes(packageName)) {
        state.completed.push(packageName);
      }
      // Remove from skipped if it was added there by mistake.
      state.skipped = state.skipped.filter((p) => p !== packageName);
      showStatus(`Success: ${packageName}`, 'success');
    }

    // Auto-advance if enabled OR if already configured/not found (always auto-advance for skips).
    const shouldAutoAdvance =
      alreadyConfigured ||
      notFound ||
      (state.config.navigationMode === 'auto' && state.status === 'running');

    if (shouldAutoAdvance && state.status === 'running') {
      state.currentIndex++;
      await saveState();

      if (state.currentIndex < state.packages.length) {
        // Shorter delay for already-configured or not-found packages.
        const delay = alreadyConfigured || notFound ? 0.5 : state.config.delay;
        showStatus(`Waiting ${delay}s before next package...`, 'info');
        setTimeout(() => {
          if (state.status === 'running') {
            processCurrentPackage();
          }
        }, delay * 1000);
      } else {
        state.status = 'idle';
        await saveState();
        showStatus('All packages processed!', 'success');
      }
    }
  } else {
    if (!state.failed.includes(packageName)) {
      state.failed.push(packageName);
    }
    showStatus(`Failed: ${packageName} - ${error}`, 'error');
  }

  await saveState();
  updateUI();
}

// Initialize when DOM is ready.
document.addEventListener('DOMContentLoaded', init);
