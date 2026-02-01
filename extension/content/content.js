// Content script for npm package access pages.
// Handles form filling and success detection.

(function () {
  'use strict';

  // State.
  let currentConfig = null;
  let observing = false;

  // Check if this is a 404/not found page (package doesn't exist on npm).
  function isNotFoundPage() {
    // Check for JSON "Not Found" response.
    const bodyText = document.body?.textContent || '';
    if (bodyText.includes('"message":"Not Found"') || bodyText.includes('"message": "Not Found"')) {
      return true;
    }

    // Check for npm's 404 page indicators.
    const title = document.title || '';
    if (title.includes('404') || title.includes('not found')) {
      return true;
    }

    // Check if the page lacks typical npm package page structure.
    const hasPackageHeader = document.querySelector('h1') || document.querySelector('[class*="package"]');
    const hasSettingsTab = document.querySelector('[href*="/access"]') || document.querySelector('button');
    if (!hasPackageHeader && !hasSettingsTab && bodyText.length < 500) {
      // Very short page without package structure is likely an error.
      return true;
    }

    return false;
  }

  // Check if trusted publisher is already configured for the given config.
  function isAlreadyConfigured(config) {
    // Simple check: look for Edit and Delete buttons on the page,
    // AND the page contains our owner/repo and workflow.
    const pageText = document.body?.textContent || '';
    const hasOwnerRepo = pageText.includes(`${config.owner}/${config.repository}`);
    const hasWorkflow = pageText.includes(config.workflow);

    if (!hasOwnerRepo || !hasWorkflow) {
      return false;
    }

    // Check for Edit and Delete buttons (exact text match).
    const allButtons = document.querySelectorAll('button');
    let hasEditButton = false;
    let hasDeleteButton = false;

    for (const btn of allButtons) {
      const btnText = btn.textContent?.trim();
      if (btnText === 'Edit') hasEditButton = true;
      if (btnText === 'Delete') hasDeleteButton = true;
    }

    const result = hasEditButton && hasDeleteButton;
    console.log(`[npm-trusted-publisher] isAlreadyConfigured check: hasOwnerRepo=${hasOwnerRepo}, hasWorkflow=${hasWorkflow}, hasEdit=${hasEditButton}, hasDelete=${hasDeleteButton} => ${result}`);

    return result;
  }

  // Set input value in a React-compatible way.
  function setInputValue(element, value) {
    if (!element) return false;

    // Get the native value setter.
    const descriptor =
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');

    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }

    // Dispatch events to trigger React state updates.
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));

    return true;
  }

  // Fill the trusted publisher form.
  function fillForm(config) {
    const fields = [
      { id: 'oidc_repositoryOwner', value: config.owner },
      { id: 'oidc_repositoryName', value: config.repository },
      { id: 'oidc_workflowName', value: config.workflow },
      { id: 'oidc_githubEnvironmentName', value: config.environment || '' },
    ];

    let filled = 0;
    for (const field of fields) {
      const element = document.getElementById(field.id);
      if (element && setInputValue(element, field.value)) {
        filled++;
      }
    }

    return filled > 0;
  }

  // Click the "GitHub Actions" button if needed.
  function clickGitHubActionsButton() {
    // Find button with text "GitHub Actions".
    const buttons = document.querySelectorAll('button');
    for (const button of buttons) {
      if (button.textContent.includes('GitHub Actions')) {
        button.click();
        return true;
      }
    }
    return false;
  }

  // Click the "Set up connection" button.
  function clickSetupButton() {
    // Find the submit button in the form.
    const buttons = document.querySelectorAll('button[type="submit"], button');
    for (const button of buttons) {
      const text = button.textContent.toLowerCase();
      if (text.includes('set up connection') || text.includes('setup connection')) {
        button.click();
        return true;
      }
    }
    return false;
  }

  // Click the "Delete" button to remove trusted publisher config.
  function clickDeleteButton() {
    const buttons = document.querySelectorAll('button');
    for (const button of buttons) {
      const text = button.textContent?.trim();
      if (text === 'Delete') {
        button.click();
        return true;
      }
    }
    return false;
  }

  // Check if trusted publisher can be deleted (has Delete button).
  function hasDeleteButton() {
    const buttons = document.querySelectorAll('button');
    for (const button of buttons) {
      const text = button.textContent?.trim();
      if (text === 'Delete') {
        return true;
      }
    }
    return false;
  }

  // Check if Cloudflare Turnstile or other challenge is present.
  function hasTurnstileChallenge() {
    // Check for full-page Cloudflare challenge (title says "Just a moment").
    if (document.title.includes('Just a moment')) {
      console.log('[npm-trusted-publisher] Detected full-page Cloudflare challenge (title)');
      return true;
    }

    // Check for Cloudflare challenge page structure.
    const mainWrapper = document.querySelector('.main-wrapper');
    const verifyHumanText = document.body?.textContent?.includes('Verify you are human');
    if (mainWrapper && verifyHumanText) {
      console.log('[npm-trusted-publisher] Detected Cloudflare challenge page structure');
      return true;
    }

    // Check for Turnstile iframe.
    const turnstileIframe = document.querySelector('iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"]');
    if (turnstileIframe) {
      console.log('[npm-trusted-publisher] Detected Turnstile iframe');
      return true;
    }

    // Check for Turnstile widget container.
    const turnstileWidget = document.querySelector('[class*="turnstile"], [class*="cf-turnstile"], #cf-turnstile');
    if (turnstileWidget) {
      console.log('[npm-trusted-publisher] Detected Turnstile widget');
      return true;
    }

    // Check for OTP/verification input.
    const otpInput = document.querySelector('input[name*="otp"], input[name*="code"], input[placeholder*="code"], input[autocomplete="one-time-code"]');
    if (otpInput) {
      console.log('[npm-trusted-publisher] Detected OTP input');
      return true;
    }

    // Check for "Ray ID" which appears on Cloudflare challenge pages.
    if (document.body?.textContent?.includes('Ray ID:')) {
      console.log('[npm-trusted-publisher] Detected Cloudflare Ray ID');
      return true;
    }

    return false;
  }

  // Wait for Turnstile/challenge to be completed.
  function waitForChallengeCompletion(timeout = 120000) {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const checkChallenge = () => {
        // If no challenge present, we're done.
        if (!hasTurnstileChallenge()) {
          resolve(true);
          return;
        }

        // Timeout after 2 minutes.
        if (Date.now() - startTime > timeout) {
          console.log('[npm-trusted-publisher] Challenge timeout, proceeding anyway');
          resolve(false);
          return;
        }

        // Check again in 500ms.
        setTimeout(checkChallenge, 500);
      };

      checkChallenge();
    });
  }

  // Check for success notification.
  function checkForSuccess() {
    // Check various possible success indicators.
    const selectors = [
      '#notification[role="alert"]',
      '[role="alert"]',
      '[class*="notification"]',
      '[class*="success"]',
      '[class*="toast"]',
    ];

    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const text = el.textContent || '';
        if (text.includes('Successfully') || text.includes('successfully')) {
          console.log(`[npm-trusted-publisher] Success detected: "${text.substring(0, 100)}"`);
          return true;
        }
      }
    }

    return false;
  }

  // Check for error messages.
  function checkForError() {
    const notification = document.querySelector('#notification[role="alert"]');
    if (notification) {
      const text = notification.textContent;
      if (text.includes('error') || text.includes('Error') || text.includes('failed')) {
        return text;
      }
    }
    return null;
  }

  // Get current package name from URL.
  function getPackageName() {
    const match = window.location.pathname.match(/\/package\/(.+?)\/access/);
    if (match) {
      return decodeURIComponent(match[1]);
    }
    return null;
  }

  // Check if we're on a package access page.
  function isAccessPage() {
    return window.location.pathname.includes('/access');
  }

  // Wait for element to appear.
  function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }

      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          observer.disconnect();
          resolve(element);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element ${selector} not found within ${timeout}ms`));
      }, timeout);
    });
  }

  // Setup mutation observer to detect success/failure.
  function setupSuccessObserver(packageName) {
    if (observing) return;
    observing = true;
    console.log(`[npm-trusted-publisher] Setting up success observer for ${packageName}`);

    const observer = new MutationObserver(() => {
      if (checkForSuccess()) {
        observer.disconnect();
        observing = false;
        console.log(`[npm-trusted-publisher] SUCCESS detected for ${packageName}, marking as completed`);

        // Report success to popup - this is a COMPLETED package, not skipped.
        chrome.runtime.sendMessage({
          action: 'packageResult',
          success: true,
          packageName: packageName,
          completed: true, // Explicitly mark as completed, not skipped.
        }).catch((err) => {
          console.log(`[npm-trusted-publisher] Message send failed, updating storage directly`);
        });

        // Also update storage directly to ensure it's tracked as completed.
        chrome.storage.local.get(['trustedPublisherState']).then((stored) => {
          const state = stored.trustedPublisherState;
          if (state) {
            if (!state.completed) state.completed = [];
            if (!state.completed.includes(packageName)) {
              state.completed.push(packageName);
            }
            chrome.storage.local.set({ trustedPublisherState: state });
          }
        });
      } else {
        const error = checkForError();
        if (error) {
          observer.disconnect();
          observing = false;
          console.log(`[npm-trusted-publisher] ERROR detected for ${packageName}: ${error}`);

          // Report failure to popup.
          chrome.runtime.sendMessage({
            action: 'packageResult',
            success: false,
            packageName: packageName,
            error: error,
          }).catch(() => {});
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Stop observing after 60 seconds.
    setTimeout(() => {
      if (observing) {
        observer.disconnect();
        observing = false;
      }
    }, 60000);
  }

  // Handle page load - auto-fill if state is running.
  async function handlePageLoad() {
    // Get state from storage first to check if we're running.
    const stored = await chrome.storage.local.get(['trustedPublisherState']);
    const state = stored.trustedPublisherState;

    if (!state || state.status !== 'running') {
      return;
    }

    // Check for full-page Cloudflare challenge BEFORE checking if we're on access page.
    // The challenge page replaces the entire page content.
    if (hasTurnstileChallenge()) {
      console.log('[npm-trusted-publisher] Full-page challenge detected on load, waiting...');
      chrome.runtime.sendMessage({
        action: 'packageResult',
        success: false,
        packageName: state.packages[state.currentIndex],
        error: 'Waiting for Cloudflare challenge...',
        waiting: true,
      }).catch(() => {});

      await waitForChallengeCompletion();
      console.log('[npm-trusted-publisher] Challenge completed, reloading page state...');

      // After challenge, the page should redirect/reload to the actual content.
      // Wait a moment and re-run.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      handlePageLoad();
      return;
    }

    // Only run on package access pages.
    if (!isAccessPage()) {
      return;
    }

    const packageName = getPackageName();
    if (!packageName) return;

    // Check if this is the expected package.
    const expectedPackage = state.packages[state.currentIndex];
    if (packageName !== expectedPackage) {
      return;
    }

    // Wait for page content to load.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check if this is a 404/not found page (package not published).
    if (isNotFoundPage()) {
      console.log(`[npm-trusted-publisher] Package ${packageName} not found (404), skipping.`);

      // Update storage directly and navigate to next package.
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
        setTimeout(() => {
          const nextPkg = state.packages[state.currentIndex];
          const nextUrl = `https://www.npmjs.com/package/${nextPkg}/access`;
          console.log(`[npm-trusted-publisher] Navigating to next: ${nextPkg}`);
          window.location.href = nextUrl;
        }, 500);
      }

      chrome.runtime.sendMessage({
        action: 'packageResult',
        success: true,
        packageName: packageName,
        notFound: true,
      }).catch(() => {});
      return;
    }

    // Check if there's a success notification visible (package was JUST configured).
    // This takes priority over isAlreadyConfigured check.
    if (checkForSuccess()) {
      console.log(`[npm-trusted-publisher] Package ${packageName} shows success notification - was just configured!`);

      // Mark as completed and advance to next package.
      if (!state.completed) state.completed = [];
      if (!state.completed.includes(packageName)) {
        state.completed.push(packageName);
      }
      state.currentIndex++;

      if (state.currentIndex >= state.packages.length) {
        state.status = 'idle';
        await chrome.storage.local.set({ trustedPublisherState: state });
        console.log('[npm-trusted-publisher] All packages processed!');
      } else {
        await chrome.storage.local.set({ trustedPublisherState: state });
        setTimeout(() => {
          const nextPkg = state.packages[state.currentIndex];
          const nextUrl = `https://www.npmjs.com/package/${nextPkg}/access`;
          console.log(`[npm-trusted-publisher] Navigating to next: ${nextPkg}`);
          window.location.href = nextUrl;
        }, 500);
      }

      chrome.runtime.sendMessage({
        action: 'packageResult',
        success: true,
        packageName: packageName,
        completed: true,
      }).catch(() => {});
      return;
    }

    // Handle DELETE mode.
    if (state.config.mode === 'delete') {
      console.log(`[npm-trusted-publisher] DELETE mode for ${packageName}`);

      // Check for and wait for any Turnstile/challenge before proceeding.
      if (hasTurnstileChallenge()) {
        console.log(`[npm-trusted-publisher] Challenge detected, waiting for completion...`);
        chrome.runtime.sendMessage({
          action: 'packageResult',
          success: false,
          packageName: packageName,
          error: 'Waiting for challenge completion...',
          waiting: true,
        }).catch(() => {});

        await waitForChallengeCompletion();
        console.log(`[npm-trusted-publisher] Challenge completed, continuing...`);

        // Re-check state after challenge (page may have reloaded).
        const storedAfterChallenge = await chrome.storage.local.get(['trustedPublisherState']);
        if (!storedAfterChallenge.trustedPublisherState || storedAfterChallenge.trustedPublisherState.status !== 'running') {
          return;
        }
      }

      if (!hasDeleteButton()) {
        console.log(`[npm-trusted-publisher] No Delete button found for ${packageName}, skipping.`);
        // No trusted publisher configured, skip.
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
          setTimeout(() => {
            const nextPkg = state.packages[state.currentIndex];
            const nextUrl = `https://www.npmjs.com/package/${nextPkg}/access`;
            console.log(`[npm-trusted-publisher] Navigating to next: ${nextPkg}`);
            window.location.href = nextUrl;
          }, 500);
        }

        chrome.runtime.sendMessage({
          action: 'packageResult',
          success: true,
          packageName: packageName,
          alreadyConfigured: true, // Treat as skipped (nothing to delete).
        }).catch(() => {});
        return;
      }

      // Setup observer for delete success.
      setupSuccessObserver(packageName);

      // Click the Delete button.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const clicked = clickDeleteButton();
      if (!clicked) {
        chrome.runtime.sendMessage({
          action: 'packageResult',
          success: false,
          packageName: packageName,
          error: 'Failed to click Delete button',
        }).catch(() => {});
        return;
      }

      // Wait for any post-click challenge (OTP, Turnstile, etc).
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (hasTurnstileChallenge()) {
        console.log(`[npm-trusted-publisher] Post-delete challenge detected, waiting...`);
        await waitForChallengeCompletion();
      }

      return;
    }

    // CONFIGURE mode - Check if trusted publisher is already configured (before this session).
    const alreadyConfigured = isAlreadyConfigured(state.config);
    console.log(`[npm-trusted-publisher] Package ${packageName}: alreadyConfigured=${alreadyConfigured}`);

    if (alreadyConfigured) {
      // Check if this package was already completed during this session.
      const wasCompletedThisSession = state.completed && state.completed.includes(packageName);

      if (wasCompletedThisSession) {
        console.log(`[npm-trusted-publisher] Package ${packageName} already in completed list, not marking as skipped.`);
      } else {
        console.log(`[npm-trusted-publisher] Package ${packageName} already configured (before this session), skipping.`);
        // Add to skipped list.
        if (!state.skipped) state.skipped = [];
        if (!state.skipped.includes(packageName)) {
          state.skipped.push(packageName);
        }
      }

      state.currentIndex++;

      // Check if we're done.
      if (state.currentIndex >= state.packages.length) {
        state.status = 'idle';
        await chrome.storage.local.set({ trustedPublisherState: state });
        console.log('[npm-trusted-publisher] All packages processed!');
      } else {
        await chrome.storage.local.set({ trustedPublisherState: state });
        // Navigate to next package after a short delay.
        setTimeout(() => {
          const nextPkg = state.packages[state.currentIndex];
          const nextUrl = `https://www.npmjs.com/package/${nextPkg}/access`;
          console.log(`[npm-trusted-publisher] Navigating to next: ${nextPkg}`);
          window.location.href = nextUrl;
        }, 500);
      }

      // Notify popup - send correct flags so it doesn't re-add to skipped.
      chrome.runtime.sendMessage({
        action: 'packageResult',
        success: true,
        packageName: packageName,
        alreadyConfigured: !wasCompletedThisSession, // Only true if NOT already completed.
        completed: wasCompletedThisSession, // Mark as completed if it was.
      }).catch(() => {
        // Popup might not be open, that's fine.
      });
      return;
    }

    // Wait for form to be available.
    try {
      await waitForElement('#oidc_repositoryOwner', 10000);
    } catch {
      // Form field might already exist via "GitHub Actions" button.
      clickGitHubActionsButton();
      try {
        await waitForElement('#oidc_repositoryOwner', 5000);
      } catch {
        chrome.runtime.sendMessage({
          action: 'packageResult',
          success: false,
          packageName: packageName,
          error: 'Could not find form fields',
        });
        return;
      }
    }

    // Small delay to ensure React has rendered.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Fill the form.
    const filled = fillForm(state.config);
    if (!filled) {
      chrome.runtime.sendMessage({
        action: 'packageResult',
        success: false,
        packageName: packageName,
        error: 'Failed to fill form',
      });
      return;
    }

    // Setup success observer.
    setupSuccessObserver(packageName);

    // Auto-submit if configured.
    if (state.config.autoSubmit) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      clickSetupButton();
    }
  }

  // Listen for messages from popup.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'fillForm') {
      currentConfig = message.config;
      const packageName = getPackageName();

      // Try clicking GitHub Actions button first if form not visible.
      if (!document.getElementById('oidc_repositoryOwner')) {
        clickGitHubActionsButton();

        // Wait a moment for form to appear.
        setTimeout(() => {
          const filled = fillForm(currentConfig);
          if (filled && packageName) {
            setupSuccessObserver(packageName);
          }
          sendResponse({ success: filled });
        }, 500);

        return true; // Keep channel open for async response.
      }

      const filled = fillForm(currentConfig);
      if (filled && packageName) {
        setupSuccessObserver(packageName);
      }
      sendResponse({ success: filled });
      return true;
    }

    if (message.action === 'clickSubmit') {
      const clicked = clickSetupButton();
      sendResponse({ success: clicked });
      return true;
    }

    if (message.action === 'checkStatus') {
      const success = checkForSuccess();
      const error = checkForError();
      sendResponse({ success, error });
      return true;
    }
  });

  // Run on page load.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', handlePageLoad);
  } else {
    handlePageLoad();
  }
})();
