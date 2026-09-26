import { cleanText } from "../utils/textCleaner.js";
import { askAI } from "../utils/aiAdapter.js";
// NOTE: Ensure aiAdapter.js accepts 4th parameter (maxTokens) and passes it to API calls

// ===== LOCKED-IN LIMITS =====
const LIMITS = {
  FREE: {
    tabs: 3,
    dailyActions: 10,
    features: ['ask'],
    model: 'groq',
    tabGroups: false
  },
  PRO: {
    tabs: 8,
    dailyActions: 50,  // Updated from 120 to 50
    features: ['ask', 'compare'],
    model: 'openai',
    tabGroups: true
  },
  POWER: {
    tabs: 15,
    dailyActions: Infinity,
    features: ['ask', 'compare'],
    model: 'openai',
    tabGroups: true
  }
};

// Maximum output tokens to control costs
const MAX_OUTPUT_TOKENS = 1000;

// ===== LEMON SQUEEZY CONFIG =====
const LEMON_SQUEEZY = {
  checkoutUrl: 'https://zxvozay.lemonsqueezy.com/checkout/buy/14310302-dcda-482f-a55e-8cf22ad64c27', // Replace with actual product ID
  apiEndpoint: 'https://backend.eolarak.workers.dev/check-subscription'
};

// Tab groups storage
let tabGroups = {}; // { groupName: [tabIds] }
let activeGroups = new Set(); // Can have multiple active groups

// ===== USER STATE =====
let IS_PRO_USER = false; // Will be set dynamically from subscription check
let userPlan = 'FREE'; // FREE, PRO, or POWER
let userEmail = null; // User email for subscription verification

// ===== DOM ELEMENTS =====
const askBtn = document.getElementById("ask");
const compareBtn = document.getElementById("compare");
const questionInput = document.getElementById("question");
const apiKeyInput = document.getElementById("apikey");
const apiKeyStatus = document.getElementById("apiKeyStatus");
const advancedToggle = document.getElementById("advancedToggle");
const advancedSection = document.getElementById("advancedSection");
const emptyState = document.getElementById("emptyState");
const selectTabsBtn = document.getElementById("selectTabsBtn");
const tabModeText = document.getElementById("tabModeText");
const selectedTabCount = document.getElementById("selectedTabCount");
const tabSelectionModal = document.getElementById("tabSelectionModal");
const closeModal = document.getElementById("closeModal");
const cancelTabSelection = document.getElementById("cancelTabSelection");
const confirmTabSelection = document.getElementById("confirmTabSelection");
const selectAllTabs = document.getElementById("selectAllTabs");
const deselectAllTabs = document.getElementById("deselectAllTabs");
const tabList = document.getElementById("tabList");
const chatContainer = document.getElementById("chatContainer");
const chatMessages = document.getElementById("chatMessages");
const clearChatBtn = document.getElementById("clearChat");
const planBadge = document.getElementById("planBadge");
const usageCount = document.getElementById("usageCount");
const dailyUsage = document.getElementById("dailyUsage");
const tabLimitNotice = document.getElementById("tabLimitNotice");

// Upgrade modal elements
const upgradeModal = document.getElementById("upgradeModal");
const closeUpgradeModal = document.getElementById("closeUpgradeModal");
const upgradeLater = document.getElementById("upgradeLater");
const upgradeNow = document.getElementById("upgradeNow");
const upgradeReason = document.getElementById("upgradeReason");
const emailInputSection = document.getElementById("emailInputSection");
const upgradeEmailInput = document.getElementById("upgradeEmailInput");
const connectedEmailSection = document.getElementById("connectedEmailSection");
const connectedEmailDisplay = document.getElementById("connectedEmailDisplay");
const changeEmailBtn = document.getElementById("changeEmailBtn");
const clearEmailBtn = document.getElementById("clearEmailBtn");
const headerUpgradeBtn = document.getElementById("headerUpgradeBtn");

// Tab groups elements
const tabGroupsSection = document.getElementById("tabGroupsSection");
const createGroupBtn = document.getElementById("createGroup");
const clearAllGroupsBtn = document.getElementById("clearAllGroups");
const groupsList = document.getElementById("groupsList");
const activeGroupsSummary = document.getElementById("activeGroupsSummary");
const activeGroupsText = document.getElementById("activeGroupsText");
const createGroupModal = document.getElementById("createGroupModal");
const closeCreateGroup = document.getElementById("closeCreateGroup");
const cancelCreateGroup = document.getElementById("cancelCreateGroup");
const saveGroupBtn = document.getElementById("saveGroup");
const groupNameInput = document.getElementById("groupName");
const groupTabsPreview = document.getElementById("groupTabsPreview");

let allTabs = [];
let selectedTabIds = new Set();
let conversationHistory = [];
let dailyActionsUsed = 0;
let lastResetDate = null;

// ===== USAGE TRACKING =====
async function loadUsageData() {
  const { 
    dailyActions = 0, 
    lastReset = null 
  } = await chrome.storage.local.get(['dailyActions', 'lastReset']);
  
  const today = new Date().toDateString();
  
  // Reset if new day
  if (lastReset !== today) {
    dailyActionsUsed = 0;
    lastResetDate = today;
    await chrome.storage.local.set({ dailyActions: 0, lastReset: today });
  } else {
    dailyActionsUsed = dailyActions;
    lastResetDate = lastReset;
  }
  
  updateUsageDisplay();
}

async function incrementUsage() {
  dailyActionsUsed++;
  await chrome.storage.local.set({ dailyActions: dailyActionsUsed });
  updateUsageDisplay();
}

function updateUsageDisplay() {
  const limit = LIMITS[userPlan].dailyActions;
  const displayLimit = limit === Infinity ? '∞' : limit;
  usageCount.textContent = `${dailyActionsUsed}/${displayLimit}`;
  
  // Warning state
  if (userPlan !== 'POWER' && dailyActionsUsed >= limit * 0.8) {
    dailyUsage.classList.add('warning');
  } else {
    dailyUsage.classList.remove('warning');
  }
}

// ===== PLAN MANAGEMENT =====

// Get or set user email for subscription verification
async function getUserEmail() {
  if (userEmail) return userEmail;
  
  let { email } = await chrome.storage.local.get(['email']);
  if (email) {
    userEmail = email;
    return email;
  }
  
  return null; // No email stored yet
}

async function setUserEmail(email) {
  userEmail = email;
  await chrome.storage.local.set({ email: email });
}

// Check subscription status from server using email
async function checkSubscriptionStatus() {
  try {
    const email = await getUserEmail();
    
    if (!email) {
      // No email stored, user is Free
      IS_PRO_USER = false;
      await chrome.storage.local.set({ isPro: false });
      return;
    }
    
    const response = await fetch(`${LEMON_SQUEEZY.apiEndpoint}?email=${encodeURIComponent(email)}`);
    
    if (response.ok) {
      const data = await response.json();
      
      // STRICT: Only PRO plan with active status
      if (data.plan === 'PRO' && data.status === 'active') {
        IS_PRO_USER = true;
        await chrome.storage.local.set({ 
          isPro: true,
          subscriptionData: data,
          lastChecked: Date.now()
        });
      } else {
        IS_PRO_USER = false;
        await chrome.storage.local.set({ isPro: false });
      }
    } else {
      // API error or no subscription found
      IS_PRO_USER = false;
      await chrome.storage.local.set({ isPro: false });
    }
  } catch (error) {
    console.error('Failed to check subscription:', error);
    const { isPro = false } = await chrome.storage.local.get(['isPro']);
    IS_PRO_USER = isPro;
  }
}

function updatePlanDisplay() {
  if (userPlan === 'POWER') {
    planBadge.textContent = 'Power';
    planBadge.classList.add('power');
    planBadge.classList.remove('pro');
    headerUpgradeBtn.style.display = 'none'; // Hide for Power users
  } else if (userPlan === 'PRO') {
    planBadge.textContent = 'Pro';
    planBadge.classList.add('pro');
    planBadge.classList.remove('power');
    headerUpgradeBtn.style.display = 'none'; // Hide for Pro users
  } else {
    planBadge.textContent = 'Free';
    planBadge.classList.remove('pro', 'power');
    headerUpgradeBtn.style.display = 'flex'; // Show for Free users
  }
  
  // Update Compare button visibility
  if (!LIMITS[userPlan].features.includes('compare')) {
    // Compare is Pro only - keep visible but will show upgrade modal on click
  }
  
  // Update tab limit notice
  updateTabLimitNotice();
  
  // Update tab groups visibility
  updateTabGroupsVisibility();
}

function updateTabLimitNotice() {
  const limit = LIMITS[userPlan].tabs;
  if (userPlan === 'FREE') {
    tabLimitNotice.textContent = `Free plan: Select up to ${limit} tabs`;
    tabLimitNotice.classList.remove('hidden');
  } else if (userPlan === 'PRO') {
    tabLimitNotice.textContent = `Pro plan: Select up to ${limit} tabs`;
    tabLimitNotice.classList.remove('hidden');
  } else {
    tabLimitNotice.textContent = `Power mode: Select up to ${limit} tabs`;
    tabLimitNotice.classList.remove('hidden');
  }
}

async function checkApiKey() {
  const { apiKey = "" } = await chrome.storage.local.get(["apiKey"]);
  if (apiKey && apiKey.trim()) {
    userPlan = 'POWER';
  } else if (IS_PRO_USER) {
    userPlan = 'PRO';
  } else {
    userPlan = 'FREE';
  }
  updatePlanDisplay();
  updateUsageDisplay();
}

// ===== LIMIT ENFORCEMENT =====
function checkTabLimit(requestedCount) {
  const limit = LIMITS[userPlan].tabs;
  if (requestedCount > limit) {
    showUpgradeModal(
      `You're trying to analyze ${requestedCount} tabs. ${
        userPlan === 'FREE' 
          ? `Free users can analyze up to ${limit} tabs. Upgrade to Pro for ${LIMITS.PRO.tabs} tabs, or use your own API key for ${LIMITS.POWER.tabs} tabs.`
          : `Pro users can analyze up to ${limit} tabs. Use your own API key for ${LIMITS.POWER.tabs} tabs and unlimited daily usage.`
      }`
    );
    return false;
  }
  return true;
}

function checkDailyLimit() {
  const limit = LIMITS[userPlan].dailyActions;
  if (dailyActionsUsed >= limit) {
    showUpgradeModal(
      `You've reached your daily limit of ${limit} actions. ${
        userPlan === 'FREE'
          ? `Upgrade to Pro for ${LIMITS.PRO.dailyActions} daily actions, or use your own API key for unlimited usage.`
          : 'Use your own API key for unlimited daily usage.'
      }`
    );
    return false;
  }
  return true;
}

function checkFeatureAccess(feature) {
  if (!LIMITS[userPlan].features.includes(feature)) {
    showUpgradeModal(
      `${feature === 'compare' ? 'Compare mode' : 'This feature'} is only available for Pro users. Upgrade to access all features!`
    );
    return false;
  }
  return true;
}

// ===== UPGRADE MODAL =====
function showUpgradeModal(reason) {
  upgradeReason.textContent = reason;
  upgradeModal.classList.add('open');
  
  // Check if email is already stored
  getUserEmail().then(email => {
    if (email) {
      // Show connected email section
      connectedEmailSection.style.display = 'block';
      connectedEmailDisplay.textContent = email;
      emailInputSection.style.display = 'none';
      upgradeNow.querySelector('.btn-text').textContent = 'Upgrade to Pro';
    } else {
      // Hide connected email, will show input on button click
      connectedEmailSection.style.display = 'none';
      emailInputSection.style.display = 'none';
      upgradeNow.querySelector('.btn-text').textContent = 'Upgrade to Pro';
    }
  });
}

function hideUpgradeModal() {
  upgradeModal.classList.remove('open');
  // Reset both email sections
  connectedEmailSection.style.display = 'none';
  emailInputSection.style.display = 'none';
  upgradeEmailInput.value = '';
  upgradeEmailInput.style.borderColor = '';
  upgradeNow.querySelector('.btn-text').textContent = 'Upgrade to Pro';
}

closeUpgradeModal.addEventListener('click', hideUpgradeModal);
upgradeLater.addEventListener('click', hideUpgradeModal);

// Header upgrade button
headerUpgradeBtn.addEventListener('click', () => {
  showUpgradeModal('Unlock all features with Tabwise Pro!');
});

// Change email button
changeEmailBtn.addEventListener('click', () => {
  // Hide connected email section
  connectedEmailSection.style.display = 'none';
  // Show email input section
  emailInputSection.style.display = 'block';
  upgradeEmailInput.value = ''; // Clear for new entry
  upgradeEmailInput.focus();
  upgradeNow.querySelector('.btn-text').textContent = 'Update & Continue';
});

// Clear email button (logout)
clearEmailBtn.addEventListener('click', async () => {
  if (confirm('Clear your email? You will need to enter it again to upgrade.')) {
    // Clear email from storage
    userEmail = null;
    await chrome.storage.local.remove('email');
    
    // Hide connected section
    connectedEmailSection.style.display = 'none';
    
    showToast('Email cleared', 'info');
    
    // Close modal
    hideUpgradeModal();
  }
});

upgradeNow.addEventListener('click', async () => {
  // Check if we already have email stored
  let email = await getUserEmail();
  
  // If email is stored and connected section is visible, proceed directly to checkout
  if (email && connectedEmailSection.style.display !== 'none') {
    // Build checkout URL with stored email
    const checkoutUrl = new URL(LEMON_SQUEEZY.checkoutUrl);
    checkoutUrl.searchParams.append('checkout[email]', email);
    
    // Open checkout in new tab
    chrome.tabs.create({ url: checkoutUrl.toString() });
    
    hideUpgradeModal();
    showToast('Opening checkout... Check your new tab!', 'info');
    
    // Start polling for subscription activation
    startSubscriptionPolling();
    return;
  }
  
  // If email section is not visible, show it
  if (emailInputSection.style.display === 'none') {
    emailInputSection.style.display = 'block';
    upgradeEmailInput.focus();
    upgradeNow.querySelector('.btn-text').textContent = 'Continue to Checkout';
    return;
  }
  
  // Get email from input
  email = upgradeEmailInput.value.trim();
  if (!email || !email.includes('@')) {
    upgradeEmailInput.style.borderColor = '#ef4444';
    showToast('Valid email required for checkout', 'error');
    upgradeEmailInput.focus();
    return;
  }
  
  // Store email before opening checkout
  await setUserEmail(email);
  
  // Build checkout URL with email prefilled
  const checkoutUrl = new URL(LEMON_SQUEEZY.checkoutUrl);
  checkoutUrl.searchParams.append('checkout[email]', email);
  
  // Open checkout in new tab
  chrome.tabs.create({ url: checkoutUrl.toString() });
  
  // Reset UI
  emailInputSection.style.display = 'none';
  upgradeEmailInput.value = '';
  upgradeEmailInput.style.borderColor = '';
  upgradeNow.querySelector('.btn-text').textContent = 'Upgrade to Pro';
  
  hideUpgradeModal();
  showToast('Opening checkout... Check your new tab!', 'info');
  
  // Start polling for subscription activation
  startSubscriptionPolling();
});

upgradeModal.addEventListener('click', (e) => {
  if (e.target === upgradeModal) {
    hideUpgradeModal();
  }
});

// Poll for subscription status after checkout
let pollingInterval = null;

function startSubscriptionPolling() {
  // Check every 3 seconds for up to 5 minutes
  let attempts = 0;
  const maxAttempts = 100; // 5 minutes
  
  if (pollingInterval) clearInterval(pollingInterval);
  
  pollingInterval = setInterval(async () => {
    attempts++;
    
    await checkSubscriptionStatus();
    await checkApiKey(); // This will update userPlan based on IS_PRO_USER
    
    if (IS_PRO_USER) {
      // Success! User is now Pro
      clearInterval(pollingInterval);
      pollingInterval = null;
      
      hideUpgradeModal();
      showToast('🎉 Welcome to Tabwise Pro! All features unlocked.', 'success');
      
      // Refresh UI
      updatePlanDisplay();
    } else if (attempts >= maxAttempts) {
      // Timeout
      clearInterval(pollingInterval);
      pollingInterval = null;
      showToast('Taking longer than expected. Please refresh the page.', 'info');
    }
  }, 3000);
}


// ===== ADVANCED SETTINGS =====
advancedToggle.addEventListener("click", () => {
  const isOpen = advancedSection.classList.contains("open");
  
  if (isOpen) {
    advancedSection.classList.remove("open");
    advancedToggle.classList.remove("active");
    advancedToggle.querySelector("span").textContent = "Advanced options";
  } else {
    advancedSection.classList.add("open");
    advancedToggle.classList.add("active");
    advancedToggle.querySelector("span").textContent = "Hide advanced options";
  }
});

// ===== TAB SELECTION =====
async function loadTabs() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_TABS" }, (tabs) => {
      const readableTabs = tabs.filter(
        (t) =>
          t.id &&
          t.url &&
          !t.url.startsWith("chrome://") &&
          !t.url.startsWith("edge://") &&
          !t.url.startsWith("chrome-extension://")
      );
      resolve(readableTabs);
    });
  });
}

function updateTabCount() {
  const count = selectedTabIds.size;
  if (count === 0) {
    selectedTabCount.textContent = "";
    tabModeText.textContent = "All tabs";
  } else {
    selectedTabCount.textContent = count;
    tabModeText.textContent = `${count} selected`;
  }
}

function renderTabList() {
  const tabLimit = LIMITS[userPlan].tabs;
  
  if (allTabs.length === 0) {
    tabList.innerHTML = `
      <div class="tab-list-empty">
        <svg viewBox="0 0 24 24" fill="none">
          <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/>
          <path d="M3 9h18" stroke="currentColor" stroke-width="2"/>
        </svg>
        <p>No readable tabs found</p>
      </div>
    `;
    return;
  }

  tabList.innerHTML = allTabs.map((tab, index) => {
    const isSelected = selectedTabIds.has(tab.id);
    // Only disable if NOT selected AND we're at the limit
    const isOverLimit = !isSelected && selectedTabIds.size >= tabLimit;
    const domain = new URL(tab.url).hostname;
    const favicon = tab.favIconUrl || `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    
    return `
      <div class="tab-item ${isSelected ? 'selected' : ''} ${isOverLimit ? 'disabled' : ''}" data-tab-id="${tab.id}">
        <div class="tab-checkbox">
          <svg viewBox="0 0 24 24" fill="none">
            <polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="tab-favicon">
          <img src="${favicon}" onerror="this.style.display='none'" alt="">
        </div>
        <div class="tab-info">
          <div class="tab-title">${tab.title || 'Untitled'}</div>
          <div class="tab-url">${domain}</div>
        </div>
      </div>
    `;
  }).join('');

  // Add click handlers
  document.querySelectorAll('.tab-item').forEach(item => {
    item.addEventListener('click', () => {
      const tabId = parseInt(item.dataset.tabId);
      
      if (selectedTabIds.has(tabId)) {
        // Deselect this tab
        selectedTabIds.delete(tabId);
        item.classList.remove('selected');
        // Re-render to update disabled states
        renderTabList();
      } else {
        // Try to select this tab
        if (selectedTabIds.size >= tabLimit) {
          showToast(`You can select up to ${tabLimit} tabs on the ${userPlan.toLowerCase()} plan`, 'error');
          return;
        }
        selectedTabIds.add(tabId);
        item.classList.add('selected');
        // Re-render to update disabled states
        renderTabList();
      }
    });
  });
}

let previousSelection = new Set();

selectTabsBtn.addEventListener('click', async () => {
  allTabs = await loadTabs();
  
  // Save current selection before opening modal
  previousSelection = new Set(selectedTabIds);
  
  // If no tabs selected, select only the first tab by default
  if (selectedTabIds.size === 0 && allTabs.length > 0) {
    selectedTabIds.add(allTabs[0].id);
  }
  
  renderTabList();
  tabSelectionModal.classList.add('open');
});

closeModal.addEventListener('click', () => {
  // Restore previous selection
  selectedTabIds = new Set(previousSelection);
  tabSelectionModal.classList.remove('open');
});

cancelTabSelection.addEventListener('click', () => {
  // Restore previous selection
  selectedTabIds = new Set(previousSelection);
  tabSelectionModal.classList.remove('open');
});

confirmTabSelection.addEventListener('click', () => {
  updateTabCount();
  tabSelectionModal.classList.remove('open');
  const count = selectedTabIds.size;
  if (count === 0) {
    showToast('No tabs selected - using all available tabs', 'success');
  } else {
    showToast(`${count} tab${count !== 1 ? 's' : ''} selected`, 'success');
  }
});

selectAllTabs.addEventListener('click', () => {
  const tabLimit = LIMITS[userPlan].tabs;
  selectedTabIds.clear();
  allTabs.slice(0, tabLimit).forEach(tab => selectedTabIds.add(tab.id));
  renderTabList();
});

deselectAllTabs.addEventListener('click', () => {
  selectedTabIds.clear();
  document.querySelectorAll('.tab-item').forEach(item => {
    item.classList.remove('selected');
  });
});

tabSelectionModal.addEventListener('click', (e) => {
  if (e.target === tabSelectionModal) {
    // Restore previous selection when clicking outside
    selectedTabIds = new Set(previousSelection);
    tabSelectionModal.classList.remove('open');
  }
});

// ===== TAB GROUPS FUNCTIONALITY =====

// Load groups from storage
async function loadTabGroups() {
  const { groups = {} } = await chrome.storage.local.get(['groups']);
  tabGroups = groups;
  renderGroupsList();
}

// Save groups to storage
async function saveTabGroups() {
  await chrome.storage.local.set({ groups: tabGroups });
}

// Render groups list
function renderGroupsList() {
  if (Object.keys(tabGroups).length === 0) {
    groupsList.innerHTML = '<div class="groups-empty"><p>No groups yet. Create one to organize your research!</p></div>';
    return;
  }

  groupsList.innerHTML = Object.entries(tabGroups).map(([name, tabIds]) => {
    const isActive = activeGroups.has(name);
    return `
      <div class="group-item ${isActive ? 'active' : ''}" data-group-name="${name}">
        <div class="group-info">
          <div class="group-name">${name}</div>
          <div class="group-meta">${tabIds.length} tab${tabIds.length !== 1 ? 's' : ''}</div>
        </div>
        <div class="group-actions">
          <button class="group-action-btn toggle-group" title="${isActive ? 'Deselect group' : 'Select group'}">
            <svg viewBox="0 0 24 24" fill="none">
              ${isActive 
                ? '<path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
                : '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>'
              }
            </svg>
          </button>
          <button class="group-action-btn delete-group delete" title="Delete group">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Add event listeners
  document.querySelectorAll('.toggle-group').forEach((btn, index) => {
    const groupName = Object.keys(tabGroups)[index];
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleGroup(groupName);
    });
  });

  document.querySelectorAll('.delete-group').forEach((btn, index) => {
    const groupName = Object.keys(tabGroups)[index];
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteGroup(groupName);
    });
  });
  
  // Update the tab count display
  updateTabCountFromGroups();
}

// Toggle a group (add/remove from active groups)
function toggleGroup(groupName) {
  if (activeGroups.has(groupName)) {
    // Deselecting - always allow
    activeGroups.delete(groupName);
    showToast(`Removed group: ${groupName}`, 'success');
  } else {
    // Selecting - check if we'll exceed limits
    const newTabIds = new Set(selectedTabIds);
    tabGroups[groupName].forEach(tabId => newTabIds.add(tabId));
    
    const tabLimit = LIMITS[userPlan].tabs;
    
    if (newTabIds.size > tabLimit) {
      showUpgradeModal(
        `Adding "${groupName}" would exceed your limit of ${tabLimit} tabs (${newTabIds.size} total). ${
          userPlan === 'FREE' 
            ? `Upgrade to Pro for ${LIMITS.PRO.tabs} tabs, or use your own API key for ${LIMITS.POWER.tabs} tabs.`
            : `Use your own API key for ${LIMITS.POWER.tabs} tabs.`
        }`
      );
      return;
    }
    
    // Warn if getting close to context limits
    if (newTabIds.size >= 10) {
      showToast(`⚠️ ${newTabIds.size} tabs selected - responses may be slower`, 'info');
    }
    
    activeGroups.add(groupName);
    showToast(`Added group: ${groupName}`, 'success');
  }
  
  // Combine all tabs from active groups
  selectedTabIds.clear();
  activeGroups.forEach(name => {
    tabGroups[name].forEach(tabId => selectedTabIds.add(tabId));
  });
  
  updateTabCountFromGroups();
  renderGroupsList();
}

// Update tab count based on active groups
function updateTabCountFromGroups() {
  const tabCount = selectedTabIds.size;
  const tabLimit = LIMITS[userPlan].tabs;
  
  // Show/hide clear all button
  if (activeGroups.size > 0) {
    clearAllGroupsBtn.style.display = 'flex';
    activeGroupsSummary.style.display = 'block';
    
    // Update summary text and styling based on tab count
    activeGroupsSummary.className = 'active-groups-summary';
    
    if (tabCount > tabLimit * 0.8) {
      activeGroupsSummary.classList.add('warning');
      activeGroupsText.textContent = `⚠️ ${tabCount} tabs from ${activeGroups.size} group${activeGroups.size !== 1 ? 's' : ''} (near ${tabLimit} limit)`;
    } else if (tabCount >= 10) {
      activeGroupsSummary.classList.add('warning');
      activeGroupsText.textContent = `ℹ️ ${tabCount} tabs from ${activeGroups.size} group${activeGroups.size !== 1 ? 's' : ''} (may be slower)`;
    } else {
      activeGroupsText.textContent = `✓ ${tabCount} tabs from ${activeGroups.size} group${activeGroups.size !== 1 ? 's' : ''}`;
    }
  } else {
    clearAllGroupsBtn.style.display = 'none';
    activeGroupsSummary.style.display = 'none';
  }
  
  // Update tab selector button text
  if (activeGroups.size === 0) {
    selectedTabCount.textContent = "";
    tabModeText.textContent = "All tabs";
  } else if (activeGroups.size === 1) {
    const groupName = Array.from(activeGroups)[0];
    selectedTabCount.textContent = tabCount;
    tabModeText.textContent = `Group: ${groupName}`;
  } else {
    selectedTabCount.textContent = tabCount;
    tabModeText.textContent = `${activeGroups.size} groups`;
  }
}

// Clear all active groups
clearAllGroupsBtn.addEventListener('click', () => {
  activeGroups.clear();
  selectedTabIds.clear();
  updateTabCountFromGroups();
  renderGroupsList();
  showToast('All groups cleared', 'success');
});

// Delete a group
async function deleteGroup(groupName) {
  if (confirm(`Delete group "${groupName}"?`)) {
    delete tabGroups[groupName];
    
    // Remove from active groups if it's selected
    if (activeGroups.has(groupName)) {
      activeGroups.delete(groupName);
      
      // Recalculate selected tabs
      selectedTabIds.clear();
      activeGroups.forEach(name => {
        tabGroups[name].forEach(tabId => selectedTabIds.add(tabId));
      });
      
      updateTabCountFromGroups();
    }
    
    await saveTabGroups();
    renderGroupsList();
    showToast('Group deleted', 'success');
  }
}

// Create group button handler
createGroupBtn.addEventListener('click', () => {
  if (!LIMITS[userPlan].tabGroups) {
    showUpgradeModal('Tab Groups is a Pro feature. Organize your tabs into named groups for powerful comparisons and analysis!');
    return;
  }

  if (selectedTabIds.size === 0) {
    showToast('Please select some tabs first', 'error');
    return;
  }

  // Show preview of selected tabs
  renderGroupPreview();
  createGroupModal.classList.add('open');
  groupNameInput.focus();
});

// Render group preview
async function renderGroupPreview() {
  const tabs = await loadTabs();
  const selectedTabs = tabs.filter(t => selectedTabIds.has(t.id));
  
  groupTabsPreview.innerHTML = selectedTabs.map(tab => {
    const domain = new URL(tab.url).hostname;
    const favicon = tab.favIconUrl || `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    
    return `
      <div class="preview-tab">
        <div class="preview-tab-favicon">
          <img src="${favicon}" onerror="this.style.display='none'" alt="">
        </div>
        <div class="preview-tab-title">${tab.title || 'Untitled'}</div>
      </div>
    `;
  }).join('');
}

// Save group handler
saveGroupBtn.addEventListener('click', async () => {
  const name = groupNameInput.value.trim();
  
  if (!name) {
    showToast('Please enter a group name', 'error');
    groupNameInput.focus();
    return;
  }

  if (tabGroups[name]) {
    if (!confirm(`Group "${name}" already exists. Overwrite?`)) {
      return;
    }
  }

  // Save the group
  tabGroups[name] = Array.from(selectedTabIds);
  await saveTabGroups();
  
  // Close modal and reset
  createGroupModal.classList.remove('open');
  groupNameInput.value = '';
  
  renderGroupsList();
  showToast(`Group "${name}" saved!`, 'success');
});

// Modal close handlers
closeCreateGroup.addEventListener('click', () => {
  createGroupModal.classList.remove('open');
  groupNameInput.value = '';
});

cancelCreateGroup.addEventListener('click', () => {
  createGroupModal.classList.remove('open');
  groupNameInput.value = '';
});

createGroupModal.addEventListener('click', (e) => {
  if (e.target === createGroupModal) {
    createGroupModal.classList.remove('open');
    groupNameInput.value = '';
  }
});

// Update display when plan changes
function updateTabGroupsVisibility() {
  if (LIMITS[userPlan].tabGroups) {
    tabGroupsSection.classList.add('visible');
    tabGroupsSection.classList.remove('locked');
  } else {
    tabGroupsSection.classList.add('visible');
    tabGroupsSection.classList.add('locked');
    
    // Add click handler to locked section
    tabGroupsSection.onclick = () => {
      if (tabGroupsSection.classList.contains('locked')) {
        showUpgradeModal('Tab Groups is a Pro feature! Organize tabs into named groups like "Competitors", "Research", "Product Ideas" and run powerful comparisons.');
      }
    };
  }
}

// ===== SETTINGS =====
async function loadSettings() {
  const { apiKey = "" } = await chrome.storage.local.get(["apiKey"]);
  apiKeyInput.value = apiKey;
  
  // Show valid status if key exists
  if (apiKey && apiKey.trim()) {
    apiKeyStatus.className = 'api-key-status valid';
  }
}

apiKeyInput.addEventListener("change", async () => {
  const apiKey = apiKeyInput.value.trim();
  
  // Hide status initially
  apiKeyStatus.className = 'api-key-status';
  
  if (!apiKey) {
    // Key removed - clear it and revert to previous tier
    await chrome.storage.local.set({ apiKey: "" });
    await checkApiKey(); // This will properly update the tier
    showToast("API key removed", "success");
    return;
  }
  
  // Validate format
  if (!apiKey.startsWith('sk-')) {
    apiKeyStatus.className = 'api-key-status invalid';
    showToast("Invalid API key format. OpenAI keys start with 'sk-'", "error");
    apiKeyInput.value = "";
    setTimeout(() => {
      apiKeyStatus.className = 'api-key-status';
    }, 2000);
    return;
  }
  
  if (apiKey.length < 20) {
    apiKeyStatus.className = 'api-key-status invalid';
    showToast("API key looks too short. Please check and try again.", "error");
    apiKeyInput.value = "";
    setTimeout(() => {
      apiKeyStatus.className = 'api-key-status';
    }, 2000);
    return;
  }
  
  // Show validating state - but DON'T change tier yet
  apiKeyStatus.className = 'api-key-status validating';
  apiKeyInput.disabled = true;
  showToast("Validating API key...", "info");
  
  // Test the key with a minimal API call
  const isValid = await testOpenAIKey(apiKey);
  
  if (isValid) {
    // Key is valid - NOW we can save it and upgrade to POWER
    apiKeyStatus.className = 'api-key-status valid';
    await chrome.storage.local.set({ apiKey: apiKey });
    await checkApiKey(); // This will update tier to POWER
    apiKeyInput.disabled = false;
    showToast("✓ API key validated - Power mode activated!", "success");
    
    // Keep the checkmark visible
    setTimeout(() => {
      apiKeyStatus.className = 'api-key-status';
    }, 3000);
  } else {
    // Key is invalid - DON'T save, DON'T change tier, just clear the input
    apiKeyStatus.className = 'api-key-status invalid';
    apiKeyInput.value = "";
    apiKeyInput.disabled = false;
    showToast("Invalid API key. Please check your key and try again.", "error");
    // User stays on their current tier (Free or Pro)
    
    setTimeout(() => {
      apiKeyStatus.className = 'api-key-status';
    }, 2000);
  }
});

async function testOpenAIKey(apiKey) {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    return response.ok;
  } catch (error) {
    console.error('API key validation error:', error);
    return false;
  }
}

function resolveModelAndKey(userApiKey) {
  if (userApiKey) return { model: "openai", apiKey: userApiKey };
  if (userPlan === 'PRO') return { model: "openai", apiKey: null }; // aiAdapter will use its internal OPENAI_API_KEY
  return { model: "groq", apiKey: null };
}

// ===== TAB CONTEXT =====

async function ensureContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      { target: { tabId }, files: ["content.js"] },
      () => resolve()
    );
  });
}

async function extractTextFromTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "EXTRACT_TEXT" }, (res) => {
      if (chrome.runtime.lastError || !res?.text) resolve("");
      else resolve(cleanText(res.text));
    });
  });
}

async function getTabContext() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_TABS" }, async (tabs) => {
      let readableTabs = tabs.filter(
        (t) =>
          t.id &&
          t.url &&
          !t.url.startsWith("chrome://") &&
          !t.url.startsWith("edge://") &&
          !t.url.startsWith("chrome-extension://")
      );

      const isSelectedMode = selectedTabIds.size > 0;
      if (isSelectedMode) {
        // User explicitly selected these tabs - use them as-is
        readableTabs = readableTabs.filter(t => selectedTabIds.has(t.id));
      } else {
        // Auto mode - respect the tab limit
        const tabLimit = LIMITS[userPlan].tabs;
        readableTabs = readableTabs.slice(0, tabLimit);
      }

      if (readableTabs.length === 0) {
        resolve({ context: "", tabCount: 0, isSelectedMode });
        return;
      }

      const texts = await Promise.all(
        readableTabs.map(async (tab) => {
          await ensureContentScript(tab.id);
          return extractTextFromTab(tab.id);
        })
      );

      // Join context but DON'T trim here - let aiAdapter trim the complete prompt
      const context = texts.filter(Boolean).join("\n\n");
      
      resolve({ context, tabCount: readableTabs.length, isSelectedMode });
    });
  });
}

// ===== UI HELPERS =====
function setButtonLoading(button, isLoading, loadingText) {
  if (isLoading) {
    button.classList.add("loading");
    button.dataset.originalText = button.querySelector(".btn-text").textContent;
    button.querySelector(".btn-text").textContent = loadingText;
    button.disabled = true;
  } else {
    button.classList.remove("loading");
    button.querySelector(".btn-text").textContent = button.dataset.originalText || button.querySelector(".btn-text").textContent;
    button.disabled = false;
  }
}

function showToast(message, type = "info") {
  const existingToast = document.querySelector(".toast");
  if (existingToast) existingToast.remove();

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  
  const style = document.createElement("style");
  style.textContent = `
    .toast {
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 12px 20px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 500;
      box-shadow: var(--shadow);
      z-index: 1000;
      animation: toastIn 0.3s ease-out;
    }
    .toast-success {
      border-color: var(--success);
      background: rgba(16, 185, 129, 0.1);
    }
    .toast-error {
      border-color: #ef4444;
      background: rgba(239, 68, 68, 0.1);
    }
    .toast-info {
      border-color: var(--accent-primary);
      background: rgba(99, 102, 241, 0.1);
    }
    @keyframes toastIn {
      from {
        opacity: 0;
        transform: translateX(100px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
    @keyframes toastOut {
      to {
        opacity: 0;
        transform: translateX(100px);
      }
    }
  `;
  
  if (!document.querySelector("style[data-toast]")) {
    style.setAttribute("data-toast", "true");
    document.head.appendChild(style);
  }
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = "toastOut 0.3s ease-out forwards";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ===== CHAT FUNCTIONS =====
function formatMessageContent(text) {
  let formatted = text
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.*?)__/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    .replace(/^\* (.*$)/gim, '<li>$1</li>')
    .replace(/^\- (.*$)/gim, '<li>$1</li>')
    .replace(/^\+ (.*$)/gim, '<li>$1</li>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
  
  formatted = formatted.replace(/(<li>.*?<\/li>\s*)+/g, (match) => {
    return '<ul>' + match + '</ul>';
  });
  
  if (!formatted.startsWith('<h') && !formatted.startsWith('<ul')) {
    formatted = '<p>' + formatted + '</p>';
  }
  
  return formatted;
}

function addMessage(role, content, isAction = false) {
  chatContainer.classList.add('active');
  emptyState.classList.add('hidden');
  
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}`;
  
  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  if (role === 'system') {
    messageDiv.innerHTML = `
      <div class="message-bubble">
        <svg viewBox="0 0 24 24" fill="none">
          <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
          <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
          <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
          <rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span>${content}</span>
      </div>
    `;
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTo({
      top: chatMessages.scrollHeight,
      behavior: 'smooth'
    });
    return;
  }
  
  const icon = role === 'user' 
    ? '<svg viewBox="0 0 24 24" fill="none"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="2"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" fill="currentColor"/></svg>';
  
  const label = role === 'user' 
    ? (isAction ? content : 'You')
    : 'Tabwise AI';
  
  messageDiv.innerHTML = `
    <div class="message-header">
      ${icon}
      <span>${label}</span>
    </div>
    <div class="message-bubble">
      ${role === 'user' ? content : formatMessageContent(content)}
    </div>
    <div class="message-timestamp">${timestamp}</div>
  `;
  
  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTo({
    top: chatMessages.scrollHeight,
    behavior: 'smooth'
  });
  
  conversationHistory.push({ role, content, timestamp });
}

function addSystemMessage(tabCount, isSelectedMode) {
  let message;
  
  if (activeGroups.size > 0) {
    const groupNames = Array.from(activeGroups);
    if (groupNames.length === 1) {
      message = `Analyzing ${tabCount} tab${tabCount !== 1 ? 's' : ''} from group "${groupNames[0]}"`;
    } else if (groupNames.length === 2) {
      message = `Analyzing ${tabCount} tab${tabCount !== 1 ? 's' : ''} from groups "${groupNames[0]}" + "${groupNames[1]}"`;
    } else {
      message = `Analyzing ${tabCount} tab${tabCount !== 1 ? 's' : ''} from ${groupNames.length} groups`;
    }
  } else if (isSelectedMode) {
    message = `Analyzing ${tabCount} selected tab${tabCount !== 1 ? 's' : ''}`;
  } else {
    message = `Analyzing ${tabCount} tab${tabCount !== 1 ? 's' : ''} (auto mode)`;
  }
  
  addMessage('system', message);
}

function addLoadingMessage() {
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'message assistant';
  loadingDiv.id = 'loadingMessage';
  
  loadingDiv.innerHTML = `
    <div class="message-header">
      <svg viewBox="0 0 24 24" fill="none"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" fill="currentColor"/></svg>
      <span>Tabwise AI</span>
    </div>
    <div class="message-bubble">
      <div class="message-loading">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  `;
  
  chatMessages.appendChild(loadingDiv);
  chatMessages.scrollTo({
    top: chatMessages.scrollHeight,
    behavior: 'smooth'
  });
}

function removeLoadingMessage() {
  const loadingMsg = document.getElementById('loadingMessage');
  if (loadingMsg) {
    loadingMsg.remove();
  }
}

function clearChat() {
  conversationHistory = [];
  chatMessages.innerHTML = '';
  chatContainer.classList.remove('active');
  emptyState.classList.remove('hidden');
  showToast('Chat cleared', 'success');
}

clearChatBtn.addEventListener('click', () => {
  if (conversationHistory.length > 0) {
    clearChat();
  }
});

// ===== ASK BUTTON =====
askBtn.onclick = async () => {
  if (!questionInput.value.trim()) {
    questionInput.focus();
    questionInput.style.animation = "shake 0.5s";
    setTimeout(() => questionInput.style.animation = "", 500);
    return;
  }

  // Check feature access
  if (!checkFeatureAccess('ask')) return;

  // Check daily limit
  if (!checkDailyLimit()) return;

  const userQuestion = questionInput.value.trim();
  
  setButtonLoading(askBtn, true, "Thinking...");
  setButtonLoading(compareBtn, true, "");
  compareBtn.disabled = true;
  
  addMessage('user', userQuestion);
  questionInput.value = '';

  const { apiKey: userApiKey = "" } = await chrome.storage.local.get(["apiKey"]);
  const { model, apiKey } = resolveModelAndKey(userApiKey);

  const { context, tabCount, isSelectedMode } = await getTabContext();
  
  // Check tab limit
  if (!checkTabLimit(tabCount)) {
    setButtonLoading(askBtn, false, "");
    setButtonLoading(compareBtn, false, "");
    compareBtn.disabled = false;
    return;
  }
  
  if (!context) {
    addMessage('assistant', '⚠️ No readable tabs found. Please open some web pages and try again.');
    setButtonLoading(askBtn, false, "");
    setButtonLoading(compareBtn, false, "");
    compareBtn.disabled = false;
    showToast("No readable tabs found", "error");
    return;
  }

  addSystemMessage(tabCount, isSelectedMode);
  addLoadingMessage();

  try {
    const answer = await askAI(
      `Answer clearly with sections and bullet points.\n\n${context}\n\nQuestion:\n${userQuestion}`,
      model,
      apiKey,
      MAX_OUTPUT_TOKENS
    );

    removeLoadingMessage();
    addMessage('assistant', answer);
    await incrementUsage();
    showToast("Analysis complete", "success");
  } catch (error) {
    removeLoadingMessage();
    
    // Check if it's an API key error
    if (error.message.includes('401') || error.message.includes('Invalid API key') || error.message.includes('Unauthorized')) {
      addMessage('assistant', `❌ Invalid API key. Your OpenAI API key appears to be incorrect or expired. Please update it in Advanced settings.`);
      showToast("Invalid API key - check settings", "error");
      
      // Show invalid status but DON'T auto-clear (let user see what failed)
      apiKeyStatus.className = 'api-key-status invalid';
      setTimeout(() => {
        apiKeyStatus.className = 'api-key-status';
      }, 5000);
    } else {
      addMessage('assistant', `❌ Error: ${error.message}`);
      showToast("Failed to get response", "error");
    }
  }

  setButtonLoading(askBtn, false, "");
  setButtonLoading(compareBtn, false, "");
  compareBtn.disabled = false;
};

// ===== COMPARE BUTTON =====
compareBtn.onclick = async () => {
  // Check feature access (Pro only)
  if (!checkFeatureAccess('compare')) return;

  // Check daily limit
  if (!checkDailyLimit()) return;

  setButtonLoading(compareBtn, true, "Comparing...");
  setButtonLoading(askBtn, true, "");
  askBtn.disabled = true;
  
  addMessage('user', 'Compare Tabs', true);

  const { apiKey: userApiKey = "" } = await chrome.storage.local.get(["apiKey"]);
  const { model, apiKey } = resolveModelAndKey(userApiKey);

  const { context, tabCount, isSelectedMode } = await getTabContext();
  
  // Check tab limit
  if (!checkTabLimit(tabCount)) {
    setButtonLoading(compareBtn, false, "");
    setButtonLoading(askBtn, false, "");
    askBtn.disabled = false;
    return;
  }
  
  if (!context) {
    addMessage('assistant', '⚠️ No readable tabs found. Please open some web pages and try again.');
    setButtonLoading(compareBtn, false, "");
    setButtonLoading(askBtn, false, "");
    askBtn.disabled = false;
    showToast("No readable tabs found", "error");
    return;
  }

  addSystemMessage(tabCount, isSelectedMode);
  addLoadingMessage();

  try {
    const answer = await askAI(
      `Compare and contrast the following content.\nUse sections: Overview, Differences, Takeaways.\n\n${context}`,
      model,
      apiKey,
      MAX_OUTPUT_TOKENS
    );

    removeLoadingMessage();
    addMessage('assistant', answer);
    await incrementUsage();
    showToast("Comparison complete", "success");
  } catch (error) {
    removeLoadingMessage();
    
    // Check if it's an API key error
    if (error.message.includes('401') || error.message.includes('Invalid API key') || error.message.includes('Unauthorized')) {
      addMessage('assistant', `❌ Invalid API key. Your OpenAI API key appears to be incorrect or expired. Please update it in Advanced settings.`);
      showToast("Invalid API key - check settings", "error");
      
      // Show invalid status but DON'T auto-clear (let user see what failed)
      apiKeyStatus.className = 'api-key-status invalid';
      setTimeout(() => {
        apiKeyStatus.className = 'api-key-status';
      }, 5000);
    } else {
      addMessage('assistant', `❌ Error: ${error.message}`);
      showToast("Failed to get response", "error");
    }
  }

  setButtonLoading(compareBtn, false, "");
  setButtonLoading(askBtn, false, "");
  askBtn.disabled = false;
};

// ===== SHAKE ANIMATION =====
const shakeStyle = document.createElement("style");
shakeStyle.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-8px); }
    75% { transform: translateX(8px); }
  }
`;
document.head.appendChild(shakeStyle);

// ===== INITIALIZE =====
async function initialize() {
  await checkSubscriptionStatus(); // Check subscription on startup
  await loadSettings();
  await checkApiKey();
  await loadUsageData();
  await loadTabGroups();
  updatePlanDisplay();
}

initialize();