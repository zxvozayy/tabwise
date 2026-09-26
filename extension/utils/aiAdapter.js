// utils/aiAdapter.js
// AI API adapter. No provider keys live in the extension: Free and Pro
// requests go through the Tabwise backend, Power mode uses the user's own key.

export const BACKEND_URL = "https://backend.eolarak.workers.dev";

/**
 * Ask AI using selected model
 */
export async function askAI(prompt, model, apiKey = null, maxTokens = 800) {
  if (model === "groq") {
    return askGroq(prompt, maxTokens);
  } else if (model === "openai") {
    return askOpenAI(prompt, apiKey, maxTokens);
  } else {
    throw new Error(`Unknown model: ${model}`);
  }
}

/**
 * ================================
 * GROQ (FREE TIER)
 * ================================
 */
async function askGroq(prompt) {
  const clientId = await getClientId();
  return callBackend("/ask-free", { prompt: truncate(prompt), clientId });
}

/**
 * ================================
 * OPENAI (PRO or POWER)
 * ================================
 */
async function askOpenAI(prompt, apiKey, maxTokens = 800) {
  try {
    const MAX_PROMPT_CHARS = 20000;

    let finalPrompt = prompt;
    if (prompt.length > MAX_PROMPT_CHARS) {
      finalPrompt =
        prompt.substring(0, MAX_PROMPT_CHARS) +
        "\n\n[Content truncated to fit API limits]";
    }

    // ================================
    // POWER MODE (User provides key)
    // ================================
    if (apiKey) {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: finalPrompt }],
            max_tokens: maxTokens,
            temperature: 0.7,
          }),
        }
      );

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Invalid API key");
        }
        const error = await response.text();
        throw new Error(`OpenAI API error: ${error}`);
      }

      const data = await response.json();
      return data.choices[0].message.content;
    }

    // ================================
    // PRO MODE (Secure backend call)
    // ================================
    const { sessionToken } = await chrome.storage.local.get(["sessionToken"]);
    if (!sessionToken) {
      throw new Error("Please sign in with your Pro email.");
    }
    return await callBackend("/ask", { prompt: finalPrompt }, sessionToken);

  } catch (error) {
    console.error("OpenAI error:", error);

    if (
      error.message.includes("Invalid API key") ||
      error.message.includes("401")
    ) {
      throw new Error("Invalid API key");
    }

    throw new Error(
      `Failed to get response from OpenAI: ${error.message}`
    );
  }
}

/**
 * Estimate token count (approx)
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Check token limits
 */
export function isWithinTokenLimit(text, maxTokens = 15000) {
  const estimated = estimateTokens(text);
  return estimated <= maxTokens;
}

function truncate(prompt, maxChars = 20000) {
  return prompt.length > maxChars
    ? prompt.substring(0, maxChars) + "\n\n[Content truncated to fit API limits]"
    : prompt;
}

/**
 * Anonymous per-install id used for the server-side Free limit.
 */
async function getClientId() {
  let { clientId } = await chrome.storage.local.get(["clientId"]);
  if (!clientId) {
    clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId });
  }
  return clientId;
}

async function callBackend(path, body, sessionToken = null) {
  const headers = { "Content-Type": "application/json" };
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;

  const response = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));

  if (response.status === 401) throw new Error("Session expired. Please sign in again.");
  if (response.status === 403) throw new Error("Unauthorized");
  if (response.status === 429) throw new Error(data.error || "Daily limit reached");
  if (!response.ok || !data.answer) throw new Error(data.error || `Backend error ${response.status}`);
  return data.answer;
}
