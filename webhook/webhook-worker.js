/**
 * Cloudflare Worker for Lemon Squeezy Webhooks
 * 
 * Deploy: npx wrangler deploy
 * 
 * Required Environment Variables (in Cloudflare Dashboard):
 * - WEBHOOK_SECRET: Your Lemon Squeezy webhook signing secret
 * 
 * Required KV Namespace:
 * - USERS: KV namespace for storing user subscription data
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type, X-Signature',
        }
      });
    }
    
    // GET /check-subscription?userId=xxx
    if (request.method === 'GET' && url.pathname === '/check-subscription') {
      return handleSubscriptionCheck(url, env);
    }
    
    // POST / (webhook from Lemon Squeezy)
    if (request.method === 'POST' && url.pathname === '/') {
      return handleWebhook(request, env);
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

// Check if user has active subscription
async function handleSubscriptionCheck(url, env) {
  const userId = url.searchParams.get('userId');
  
  if (!userId) {
    return jsonResponse({ error: 'Missing userId' }, 400);
  }
  
  try {
    const data = await env.USERS.get(userId);
    
    if (!data) {
      return jsonResponse({ 
        plan: 'FREE', 
        status: 'none' 
      });
    }
    
    const subscription = JSON.parse(data);
    return jsonResponse(subscription);
    
  } catch (error) {
    console.error('Error checking subscription:', error);
    return jsonResponse({ error: 'Internal error' }, 500);
  }
}

// Handle webhook from Lemon Squeezy
async function handleWebhook(request, env) {
  const signature = request.headers.get('X-Signature');
  const body = await request.text();
  
  // Verify signature
  const isValid = await verifyWebhook(body, signature, env.WEBHOOK_SECRET);
  if (!isValid) {
    console.error('Invalid webhook signature');
    return new Response('Unauthorized', { status: 401 });
  }
  
  let data;
  try {
    data = JSON.parse(body);
  } catch (error) {
    return new Response('Invalid JSON', { status: 400 });
  }
  
  const event = data.meta.event_name;
  console.log('Webhook event:', event);
  
  try {
    switch (event) {
      case 'subscription_created':
      case 'subscription_updated':
      case 'subscription_payment_success':
        await handleSubscriptionActive(data, env);
        break;
        
      case 'subscription_cancelled':
      case 'subscription_expired':
      case 'subscription_payment_failed':
        await handleSubscriptionInactive(data, env);
        break;
        
      default:
        console.log('Unhandled event:', event);
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
    return new Response('Error processing webhook', { status: 500 });
  }
  
  return new Response('OK', { status: 200 });
}

// Activate Pro subscription
async function handleSubscriptionActive(data, env) {
  const attributes = data.data.attributes;
  const customData = attributes.first_subscription_item?.custom_data || attributes.custom_data || {};
  const userId = customData.user_id;
  
  if (!userId) {
    console.error('No user_id in custom data');
    return;
  }
  
  const subscriptionData = {
    plan: 'PRO',
    status: 'active',
    email: attributes.user_email,
    subscription_id: data.data.id,
    customer_id: attributes.customer_id,
    created_at: attributes.created_at,
    renews_at: attributes.renews_at,
    updated_at: new Date().toISOString()
  };
  
  await env.USERS.put(userId, JSON.stringify(subscriptionData));
  console.log('Activated Pro for user:', userId);
}

// Deactivate Pro subscription
async function handleSubscriptionInactive(data, env) {
  const attributes = data.data.attributes;
  const customData = attributes.first_subscription_item?.custom_data || attributes.custom_data || {};
  const userId = customData.user_id;
  
  if (!userId) {
    console.error('No user_id in custom data');
    return;
  }
  
  // Get existing data
  const existing = await env.USERS.get(userId);
  let existingData = {};
  if (existing) {
    existingData = JSON.parse(existing);
  }
  
  const subscriptionData = {
    ...existingData,
    plan: 'FREE',
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  await env.USERS.put(userId, JSON.stringify(subscriptionData));
  console.log('Deactivated Pro for user:', userId);
}

// Verify webhook signature
async function verifyWebhook(payload, signature, secret) {
  const encoder = new TextEncoder();
  
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload)
  );
  
  const expectedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));
  
  return signature === expectedSignature;
}

// Helper for JSON responses
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}