const MONTH = 1000 * 60 * 60 * 24 * 30;

export async function getCredits() {
  const { credits = 200, lastReset = Date.now() } =
    await chrome.storage.local.get(["credits", "lastReset"]);

  if (Date.now() - lastReset > MONTH) {
    await chrome.storage.local.set({ credits: 200, lastReset: Date.now() });
    return 200;
  }
  return credits;
}

export async function useCredits(amount) {
  const credits = await getCredits();
  if (credits < amount) return false;
  await chrome.storage.local.set({ credits: credits - amount });
  return true;
}
