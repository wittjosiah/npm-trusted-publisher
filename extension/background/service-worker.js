// Background service worker for npm trusted publisher extension.
// Handles tab management and state coordination.

// Listen for tab updates to detect navigation.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url?.includes('npmjs.com/package/') || !tab.url.includes('/access')) return;

  // Get current state.
  const stored = await chrome.storage.local.get(['trustedPublisherState']);
  const state = stored.trustedPublisherState;

  if (!state || state.status !== 'running') return;

  // Check for 404 by examining the tab title or trying to inject script.
  // 404 pages often have different titles.
  const title = tab.title || '';
  const is404 = title.includes('404') || title.includes('Not Found') || title === '';

  if (is404) {
    console.log('[npm-trusted-publisher] Detected 404 from background, handling skip...');
    await handle404Skip(state, tabId);
    return;
  }

  // Send message to content script to fill form.
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'pageLoaded',
      config: state.config,
      packageIndex: state.currentIndex,
    });
  } catch (error) {
    console.log('Content script not ready yet:', error);
    // Content script might not be injected (JSON response).
    // Try to detect if this is a 404 by executing a script.
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const text = document.body?.textContent || '';
          return text.includes('"message":"Not Found"') || text.includes('Not Found');
        },
      });
      if (results?.[0]?.result) {
        console.log('[npm-trusted-publisher] Detected 404 via script injection');
        await handle404Skip(state, tabId);
      }
    } catch (scriptError) {
      console.log('Could not inject script:', scriptError);
    }
  }
});

// Handle skipping a 404 package.
async function handle404Skip(state, tabId) {
  const packageName = state.packages[state.currentIndex];
  console.log(`[npm-trusted-publisher] Skipping 404 package: ${packageName}`);

  if (!state.skipped) state.skipped = [];
  if (!state.skipped.includes(packageName)) {
    state.skipped.push(packageName);
  }
  state.currentIndex++;

  if (state.currentIndex >= state.packages.length) {
    state.status = 'idle';
    await chrome.storage.local.set({ trustedPublisherState: state });
    console.log('[npm-trusted-publisher] All packages processed!');
  } else {
    await chrome.storage.local.set({ trustedPublisherState: state });
    // Navigate to next package.
    const nextPkg = state.packages[state.currentIndex];
    const nextUrl = `https://www.npmjs.com/package/${nextPkg}/access`;
    console.log(`[npm-trusted-publisher] Navigating to next: ${nextPkg}`);
    await chrome.tabs.update(tabId, { url: nextUrl });
  }
}

// Listen for messages from content scripts and popup.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getState') {
    chrome.storage.local.get(['trustedPublisherState']).then((stored) => {
      sendResponse(stored.trustedPublisherState || null);
    });
    return true;
  }

  if (message.action === 'updateState') {
    chrome.storage.local.set({ trustedPublisherState: message.state }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// Handle extension installation.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // Initialize default state.
    const defaultState = {
      status: 'idle',
      packages: [],
      currentIndex: 0,
      completed: [],
      failed: [],
      skipped: [],
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

    await chrome.storage.local.set({ trustedPublisherState: defaultState });
  }
});
