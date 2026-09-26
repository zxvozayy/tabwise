// utils/aiAdapter.js
// AI API adapter with cost protection via max_tokens
// Model routing: Groq (free), backend proxy (Pro), user-supplied OpenAI key (Power)



// Free-tier Groq key. Never commit a real key: set it locally before loading the unpacked extension.
// (Production hardening: proxy Groq through backend/ like the Pro path so no key ships in the client.)
const GROQ_API_KEY = "YOUR_GROQ_API_KEY";

// utils/aiAdapter.js

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
async function askGroq(prompt, maxTokens = 800) {
  try {
    const MAX_PROMPT_CHARS = 20000;

    let finalPrompt = prompt;
    if (prompt.length > MAX_PROMPT_CHARS) {
      finalPrompt =
        prompt.substring(0, MAX_PROMPT_CHARS) +
        "\n\n[Content truncated to fit API limits]";
    }

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: finalPrompt }],
          max_tokens: maxTokens,
          temperature: 0.7,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Groq API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;

  } catch (error) {
    console.error("Groq error:", error);
    throw new Error(`Failed to get response from Groq: ${error.message}`);
  }
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

    const { email } = await chrome.storage.local.get(["email"]);

    if (!email) {
      throw new Error("No email found. Please upgrade to Pro.");
    }

    const response = await fetch(
      "https://backend.eolarak.workers.dev/ask",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
 	 prompt: finalPrompt,
 	 email: email  // ✅ FIXED - use the email variable directly
	}),
      }
    );

    if (response.status === 403) {
      throw new Error("Unauthorized");
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error);
    }

    const data = await response.json();
    
    // Log the full response for debugging
    console.log("🔍 Backend response:", data);
    console.log("🔍 Response keys:", Object.keys(data));
    
    // Handle different response formats from backend
    // Try: data.answer, data.reply, data.message, data.content, or data.choices[0].message.content
    const reply = data.answer ||  // ← YOUR BACKEND USES THIS!
                  data.reply || 
                  data.message || 
                  data.content || 
                  data.choices?.[0]?.message?.content ||
                  data.response;
    
    if (!reply) {
      console.error("❌ Backend returned invalid response format");
      console.error("❌ Full response:", JSON.stringify(data, null, 2));
      throw new Error("Backend returned invalid response format. Check console for details.");
    }
    
    console.log("✅ Found response in field:", reply.substring(0, 100) + "...");
    return reply;

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